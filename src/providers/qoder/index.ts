import { resolveExecutable, run, runInteractive, type ExecResult } from '../../util/exec.js';
import { LockerError } from '../../util/errors.js';
import { sha256Hex } from '../../vault/crypto.js';
import type {
  DoctorCheck,
  Identity,
  LoginOptions,
  Provider,
  ProviderCapabilities,
  RunningProcess,
  VerifyResult,
} from '../Provider.js';
import { cliDoctorCheck } from '../shared/cli.js';
import { decodeBase64Field } from '../shared/snapshot.js';
import { cleanQoderEnv, OVERRIDING_ENV_VARS, resolveQoderEnv, type QoderEnv } from './env.js';
import { findQoderProcesses } from './process.js';
import { fetchQoderStatus, statusToIdentity, type QoderStatus, type QoderStatusResult } from './status.js';
import { MAX_QODER_SNAPSHOT_BYTES, QoderStore } from './store.js';

/**
 * Everything that makes up one Qoder CLI login on this machine. The credential itself is
 * opaque; identity is captured from `qodercli status` because the blob cannot be parsed.
 */
export interface QoderSnapshot {
  v: 1;
  /** Base64 of ~/.qoder/.auth/user. */
  user: string;
  /** Hash of .auth/machine_id at capture; Qoder blobs are machine-bound. */
  machineIdHash?: string;
  /** Identity observed when the snapshot was captured. */
  status?: QoderStatus | null;
  statusError?: string;
}

export interface QoderProviderOptions {
  env?: QoderEnv;
  store?: QoderStore;
  /** Executable name/path, default `qodercli` or AI_LOCKER_QODER_BIN. */
  qoderBin?: string;
  findProcesses?: () => Promise<RunningProcess[]>;
  statusFetcher?: (configDir: string) => Promise<QoderStatusResult>;
  versionFetcher?: () => Promise<ExecResult>;
  loginImpl?: (opts: LoginOptions) => Promise<number>;
  processEnv?: NodeJS.ProcessEnv;
}

export class QoderProvider implements Provider<QoderSnapshot> {
  readonly id = 'qoder';
  readonly displayName = 'Qoder CLI';
  readonly loginHint = 'qodercli login';
  readonly runningHint = 'Qoder CLI session';
  readonly capabilities: ProviderCapabilities = {
    login: { email: false, sso: false, console: false, host: false },
    automatedLogin: true,
    manualLogin: true,
    usage: false,
    portableExport: false,
  };
  readonly env: QoderEnv;
  private readonly store: QoderStore;
  private readonly qoderBin: string;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly findProcesses: () => Promise<RunningProcess[]>;
  private readonly statusFetcher?: (configDir: string) => Promise<QoderStatusResult>;
  private readonly versionFetcher?: () => Promise<ExecResult>;
  private readonly loginImpl?: (opts: LoginOptions) => Promise<number>;

  constructor(opts: QoderProviderOptions = {}) {
    this.processEnv = opts.processEnv ?? process.env;
    this.env = opts.env ?? resolveQoderEnv(this.processEnv);
    this.store = opts.store ?? new QoderStore(this.env);
    this.qoderBin = opts.qoderBin ?? this.processEnv.AI_LOCKER_QODER_BIN ?? 'qodercli';
    this.findProcesses = opts.findProcesses ?? (() => findQoderProcesses(this.env.platform));
    this.statusFetcher = opts.statusFetcher;
    this.versionFetcher = opts.versionFetcher;
    this.loginImpl = opts.loginImpl;
  }

  describeStore() {
    return { kind: this.store.kind, location: this.store.location };
  }

  async readLive(): Promise<QoderSnapshot | null> {
    const user = await this.store.readUser();
    if (!user) return null;
    const [machineIdHash, status] = await Promise.all([this.store.machineIdHash(), this.readStatusSafe()]);
    return {
      v: 1,
      user: user.toString('base64'),
      machineIdHash,
      status: status.status,
      statusError: status.error,
    };
  }

  async writeLive(snapshot: QoderSnapshot): Promise<void> {
    const data = decodeQoderSnapshot(snapshot);
    const local = await this.store.machineIdHash();
    if (!local) {
      throw new LockerError(
        'Qoder has no machine_id on this machine, so a saved login cannot be restored.',
        'E_QODER_MACHINE',
        'Run `qodercli login` once to create the device identity, then add the account again.',
      );
    }
    if (snapshot.machineIdHash && snapshot.machineIdHash !== local) {
      throw new LockerError(
        'This Qoder profile was captured on another machine; Qoder logins are machine-bound.',
        'E_QODER_MACHINE',
        'Sign in again on this machine with `ai-locker --provider qoder add <name>`. Exports cannot be moved between machines.',
      );
    }
    await this.store.writeUser(data);
  }

  async clearLive(): Promise<void> {
    await this.store.clearUser();
  }

  hasLogin(snapshot: QoderSnapshot): boolean {
    if (!snapshot || typeof snapshot.user !== 'string' || snapshot.user.length === 0) return false;
    return snapshot.status?.logged_in !== false;
  }

  fingerprint(snapshot: QoderSnapshot): string {
    return sha256Hex(`ai-locker-qoder-fp:${snapshot.user}`).slice(0, 16);
  }

  identity(snapshot: QoderSnapshot): Identity {
    return statusToIdentity(snapshot.status);
  }

  runningProcesses(): Promise<RunningProcess[]> {
    return this.findProcesses();
  }

  async verifyLive(expected?: Identity): Promise<VerifyResult> {
    const bin = this.executable();
    if (!bin) return { ok: true, skipped: true, detail: '`qodercli` not found on PATH; skipped verification' };
    const res = await this.runStatus(bin);
    if (!res.status) return { ok: false, detail: res.error ?? '`qodercli status` failed' };
    const status = res.status;
    if (status.auth_source === 'external') {
      return {
        ok: false,
        detail: 'Qoder CLI is using an environment credential, not the saved login; switching has no visible effect',
      };
    }
    if (status.logged_in !== true) {
      const reason = [status.auth_error_reason, status.auth_error_message].filter(Boolean).join(': ');
      return { ok: false, detail: `Qoder CLI reports it is not logged in${reason ? ` (${reason})` : ''}` };
    }
    const email = typeof status.email === 'string' ? status.email : undefined;
    const actual = statusToIdentity(status);
    if (expected?.accountKey && actual.accountKey && expected.accountKey !== actual.accountKey) {
      return { ok: false, email, detail: `Qoder CLI reports ${email ?? 'a different account'}, expected ${expected.email ?? expected.accountKey}` };
    }
    if (expected?.email && email && email.toLowerCase() !== expected.email.toLowerCase()) {
      return { ok: false, email, detail: `Qoder CLI reports ${email}, expected ${expected.email}` };
    }
    return {
      ok: true,
      email,
      detail: `logged in${email ? ` as ${email}` : ''} (${status.login_method ?? status.account_type ?? 'unknown'})`,
    };
  }

  async login(opts: LoginOptions): Promise<number> {
    if (opts.email || opts.sso || opts.console) {
      throw new LockerError(
        'Qoder CLI login does not support --email, --sso or --console.',
        'E_ARGS',
        'Run `ai-locker --provider qoder add <name>` and choose the account in the browser.',
      );
    }
    if (this.loginImpl) return this.loginImpl(opts);
    const bin = this.executable();
    if (!bin) {
      throw new LockerError('Could not find `qodercli`. Is Qoder CLI installed and on PATH?', 'E_NO_QODER');
    }
    return runInteractive(bin, ['--config-dir', this.env.configDir, 'login'], {
      env: cleanQoderEnv(this.processEnv),
    });
  }

  async preflight(): Promise<void> {
    const set = OVERRIDING_ENV_VARS.filter((k) => Boolean(this.processEnv[k]?.trim()));
    if (set.length === 0) return;
    throw new LockerError(
      `${set.join(', ')} is set, and Qoder CLI uses it instead of the saved login.`,
      'E_ENV_OVERRIDE',
      `Unset ${set.join(', ')} and retry; otherwise switching accounts has no visible effect.`,
    );
  }

  async validateSnapshot(snapshot: QoderSnapshot): Promise<{ ok: boolean; reason?: string }> {
    try {
      decodeQoderSnapshot(snapshot);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    let local: string | undefined;
    try {
      local = await this.store.machineIdHash();
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    if (!local) {
      return { ok: false, reason: 'Qoder has no machine_id on this machine; run `qodercli login` first' };
    }
    if (snapshot.machineIdHash && snapshot.machineIdHash !== local) {
      return { ok: false, reason: 'captured on another machine (Qoder credentials are machine-bound)' };
    }
    return { ok: true };
  }

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    checks.push(
      await cliDoctorCheck({
        label: 'Qoder CLI',
        command: 'qodercli',
        bin: this.executable(),
        runVersion: (bin) => this.runVersion(bin),
      }),
    );
    checks.push({ name: 'Config directory', status: 'info', detail: this.env.configDir });
    checks.push({ name: 'Credential store', status: 'info', detail: `${this.store.kind}: ${this.store.location}` });

    const machineId = await this.store.machineId().catch((err: Error) => err);
    if (machineId instanceof Error) {
      checks.push({ name: 'Machine ID', status: 'fail', detail: machineId.message });
    } else if (!machineId) {
      checks.push({
        name: 'Machine ID',
        status: 'warn',
        detail: 'missing; run `qodercli login` once to create this device identity',
      });
    } else {
      checks.push({ name: 'Machine ID', status: 'ok', detail: 'present (device-bound)' });
    }

    if (this.processEnv.QODER_CONFIG_DIR || this.processEnv.QODER_CONFIG_DIR_NAME) {
      checks.push({
        name: 'Config override',
        status: 'info',
        detail: this.processEnv.QODER_CONFIG_DIR
          ? `QODER_CONFIG_DIR=${this.processEnv.QODER_CONFIG_DIR}`
          : `QODER_CONFIG_DIR_NAME=${this.processEnv.QODER_CONFIG_DIR_NAME}`,
      });
    }

    const live = await this.readLive().catch((err: Error) => err);
    if (live instanceof Error) {
      checks.push({ name: 'Live login', status: 'fail', detail: live.message });
    } else if (!live || !this.hasLogin(live)) {
      if (live?.status?.auth_error_reason) {
        checks.push({
          name: 'Live login',
          status: 'warn',
          detail: `${live.status.auth_error_reason}${live.status.auth_error_message ? `: ${live.status.auth_error_message}` : ''}`,
        });
      } else {
        checks.push({ name: 'Live login', status: 'info', detail: 'none' });
      }
    } else {
      const id = this.identity(live);
      checks.push({
        name: 'Live login',
        status: 'ok',
        detail: `${id.email ?? 'unknown email'} (${id.plan ?? 'unknown plan'})`,
      });
      if (live.status?.login_method) {
        checks.push({ name: 'Login method', status: 'info', detail: live.status.login_method });
      }
      if (live.statusError) {
        checks.push({ name: 'Status check', status: 'warn', detail: live.statusError });
      }
      if (live.status?.auth_error_reason) {
        checks.push({
          name: 'Credential state',
          status: 'warn',
          detail: `${live.status.auth_error_reason}${live.status.auth_error_message ? `: ${live.status.auth_error_message}` : ''}`,
        });
      }
    }

    for (const k of OVERRIDING_ENV_VARS) {
      if (this.processEnv[k]) {
        checks.push({
          name: k,
          status: 'warn',
          detail: 'is set; Qoder CLI will use it instead of the stored login, so switching has no visible effect',
        });
      }
    }
    checks.push({ name: 'Usage', status: 'info', detail: 'not exposed by Qoder CLI' });
    checks.push({ name: 'Qoder IDE', status: 'info', detail: 'not managed; Qoder CLI sign-in only' });
    return checks;
  }

  /** Path to the `qodercli` executable, or null if it isn't installed. */
  private executable(): string | null {
    return resolveExecutable(this.qoderBin, this.processEnv, this.env.platform);
  }

  private async runStatus(bin: string): Promise<QoderStatusResult> {
    if (this.statusFetcher) return this.statusFetcher(this.env.configDir);
    return fetchQoderStatus({ bin, configDir: this.env.configDir, env: this.processEnv });
  }

  private async readStatusSafe(): Promise<QoderStatusResult> {
    const bin = this.executable();
    if (!bin) return { status: null, code: -1, error: '`qodercli` not found on PATH; identity unavailable' };
    try {
      return await this.runStatus(bin);
    } catch (err) {
      return { status: null, code: -1, error: (err as Error).message };
    }
  }

  private async runVersion(bin: string): Promise<ExecResult> {
    if (this.versionFetcher) return this.versionFetcher();
    return run(bin, ['--version'], { env: cleanQoderEnv(this.processEnv), timeoutMs: 30_000 });
  }
}

function decodeQoderSnapshot(snapshot: QoderSnapshot): Buffer {
  if (!snapshot || snapshot.v !== 1) {
    throw new LockerError('Unsupported Qoder profile format.', 'E_FORMAT');
  }
  return decodeBase64Field(snapshot.user, { label: 'Qoder', maxBytes: MAX_QODER_SNAPSHOT_BYTES });
}
