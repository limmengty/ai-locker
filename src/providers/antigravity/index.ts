import { resolveExecutable, run, runInteractive, type ExecResult } from '../../util/exec.js';
import { LockerError } from '../../util/errors.js';
import { keyringBackend, type KeyringBackend } from '../../util/keyring.js';
import { sha256Hex } from '../../vault/crypto.js';
import type {
  DoctorCheck,
  Identity,
  Provider,
  ProviderCapabilities,
  RunningProcess,
  VerifyResult,
} from '../Provider.js';
import {
  cleanAgyEnv,
  FILE_FALLBACK_ENV_VARS,
  GATEWAY_ENV_PREFIX,
  OVERRIDING_ENV_VARS,
  resolveAgyEnv,
  type AgyEnv,
} from './env.js';
import { assertKeyringReady, cliDoctorCheck, keyringAvailability, keyringDoctorCheck } from '../shared/cli.js';
import { decodeBase64Field } from '../shared/snapshot.js';
import { MAX_AGY_CREDENTIAL_BYTES, parseAgyCredential, type AgyCredential } from './credential.js';
import { AgyStore } from './store.js';
import { findAgyProcesses } from './process.js';

/**
 * One Antigravity CLI login is the OAuth JSON blob in the OS keyring. agy refreshes the
 * tokens in place, so a snapshot is only as fresh as the last capture.
 */
export interface AgySnapshot {
  v: 1;
  /** Base64 of the raw JSON stored under `gemini:antigravity`. */
  credential: string;
}

export interface AgyProviderOptions {
  env?: AgyEnv;
  keyring?: KeyringBackend;
  agyBin?: string;
  processEnv?: NodeJS.ProcessEnv;
  findProcesses?: () => Promise<RunningProcess[]>;
  versionFetcher?: () => Promise<ExecResult>;
  modelsFetcher?: () => Promise<ExecResult>;
  loginImpl?: () => Promise<number>;
}

export class AgyProvider implements Provider<AgySnapshot> {
  readonly id = 'agy';
  readonly displayName = 'Google Antigravity CLI';
  readonly loginHint = 'agy';
  readonly manualLoginHint =
    'In the agy TUI, type /login, finish the browser sign-in, then /quit. (`agy -p ...` runs in print mode and cannot log in.)';
  readonly runningHint = 'Antigravity CLI session';
  readonly capabilities: ProviderCapabilities = {
    login: { email: false, sso: false, console: false, host: false },
    automatedLogin: true,
    manualLogin: true,
    usage: false,
    portableExport: true,
  };
  readonly env: AgyEnv;
  private readonly keyring: KeyringBackend;
  private readonly store: AgyStore;
  private readonly agyBin: string;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly findProcesses: () => Promise<RunningProcess[]>;
  private readonly versionFetcher?: () => Promise<ExecResult>;
  private readonly modelsFetcher?: () => Promise<ExecResult>;
  private readonly loginImpl?: () => Promise<number>;

  constructor(opts: AgyProviderOptions = {}) {
    this.processEnv = opts.processEnv ?? process.env;
    this.env = opts.env ?? resolveAgyEnv();
    this.keyring = opts.keyring ?? keyringBackend(this.env.platform);
    this.store = new AgyStore(this.keyring);
    this.agyBin = opts.agyBin ?? this.processEnv.AI_LOCKER_AGY_BIN ?? 'agy';
    this.findProcesses = opts.findProcesses ?? (() => findAgyProcesses(this.env.platform));
    this.versionFetcher = opts.versionFetcher;
    this.modelsFetcher = opts.modelsFetcher;
    this.loginImpl = opts.loginImpl;
  }

  describeStore() {
    return { kind: this.store.kind, location: this.store.location };
  }

  async readLive(): Promise<AgySnapshot | null> {
    const raw = await this.store.read();
    if (!raw) return null;
    parseAgyCredential(raw);
    return { v: 1, credential: raw.toString('base64') };
  }

  async writeLive(snapshot: AgySnapshot): Promise<void> {
    await this.store.write(decodeSnapshot(snapshot));
  }

  async clearLive(): Promise<void> {
    await this.store.clear();
  }

  hasLogin(snapshot: AgySnapshot): boolean {
    try {
      const credential = parseAgyCredential(decodeSnapshot(snapshot));
      return Boolean(credential.accessToken || credential.refreshToken);
    } catch {
      return false;
    }
  }

  fingerprint(snapshot: AgySnapshot): string {
    return sha256Hex(Buffer.concat([Buffer.from('ai-locker-agy-fp:'), decodeSnapshot(snapshot)])).slice(0, 16);
  }

  identity(snapshot: AgySnapshot): Identity {
    let credential: AgyCredential;
    try {
      credential = parseAgyCredential(decodeSnapshot(snapshot));
    } catch {
      return {};
    }
    return {
      accountKey: accountKey(credential),
      email: credential.email,
      tokenExpiresAt: credential.expiresAt,
    };
  }

  runningProcesses(): Promise<RunningProcess[]> {
    return this.findProcesses();
  }

  async verifyLive(expected?: Identity): Promise<VerifyResult> {
    if (this.processEnv.SSH_TTY !== undefined) {
      return {
        ok: false,
        detail: 'SSH_TTY is set, so agy uses its file credential instead of the OS keyring',
      };
    }
    const raw = await this.store.read();
    if (!raw) return { ok: false, detail: 'Antigravity has no login in the OS keyring' };
    let credential: AgyCredential;
    try {
      credential = parseAgyCredential(raw);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    const email = credential.email;
    if (expected?.email && email && expected.email.toLowerCase() !== email.toLowerCase()) {
      return { ok: false, email, detail: `Antigravity reports ${email}, expected ${expected.email}` };
    }
    if (expected?.accountKey && expected.accountKey !== accountKey(credential)) {
      return { ok: false, email, detail: `Antigravity reports ${email ?? 'another account'}, expected ${expected.email ?? expected.accountKey}` };
    }
    const bin = this.executable();
    if (!bin) return { ok: true, skipped: true, email, detail: '`agy` not found on PATH; skipped verification' };

    const res = await this.runModels(bin);
    if (res.code !== 0) {
      return { ok: false, email, detail: failureDetail('`agy models` failed', res) };
    }
    return {
      ok: true,
      email,
      detail: `agy authenticated the saved login${email ? ` (${email})` : ''}`,
    };
  }

  async login(): Promise<number> {
    if (this.loginImpl) return this.loginImpl();
    const bin = this.executable();
    if (!bin) {
      throw new LockerError('Could not find `agy`. Is Antigravity CLI installed and on PATH?', 'E_NO_AGY');
    }
    // No arguments: agy opens its full-screen TUI, where /login starts the OAuth flow.
    return runInteractive(bin, [], { env: cleanAgyEnv(this.processEnv) });
  }

  async preflight(): Promise<void> {
    const overrides = OVERRIDING_ENV_VARS.filter((k) => Boolean(this.processEnv[k]?.trim()));
    const gateway = Object.keys(this.processEnv).filter(
      (k) => k.startsWith(GATEWAY_ENV_PREFIX) && Boolean(this.processEnv[k]?.trim()),
    );
    const all = [...overrides, ...gateway];
    if (all.length > 0) {
      throw new LockerError(
        `${all.join(', ')} is set, and agy authenticates with it instead of the saved login.`,
        'E_ENV_OVERRIDE',
        `Unset ${all.join(', ')} and retry; otherwise switching accounts has no visible effect.`,
      );
    }
    const fileMode = FILE_FALLBACK_ENV_VARS.filter((k) => this.processEnv[k] !== undefined);
    if (fileMode.length > 0) {
      throw new LockerError(
        `${fileMode.join(', ')} is set, so agy stores its login in a file instead of the OS keyring.`,
        'E_AGY_FILE_MODE',
        'Run ai-locker from a local desktop terminal (not SSH) and retry.',
      );
    }
    if (this.isRoot()) {
      throw new LockerError(
        'agy runs in file-credential mode as root, so keyring switching has no effect.',
        'E_AGY_FILE_MODE',
        'Run ai-locker as the desktop user who is signed in to Antigravity.',
      );
    }
    await assertKeyringReady(this.keyring);
  }

  async validateSnapshot(snapshot: AgySnapshot): Promise<{ ok: boolean; reason?: string }> {
    try {
      parseAgyCredential(decodeSnapshot(snapshot));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    checks.push(
      await cliDoctorCheck({
        label: 'Antigravity CLI',
        command: 'agy',
        bin: this.executable(),
        runVersion: (bin) => this.runVersion(bin),
      }),
    );
    checks.push({ name: 'State directory', status: 'info', detail: this.env.stateDir });
    checks.push({ name: 'Config directory', status: 'info', detail: this.env.configDir });

    checks.push(keyringDoctorCheck(this.keyring, await keyringAvailability(this.keyring)));

    let credential: AgyCredential | null = null;
    try {
      const raw = await this.store.read();
      if (!raw) {
        checks.push({ name: 'Saved login', status: 'info', detail: 'none' });
      } else {
        credential = parseAgyCredential(raw);
        checks.push({
          name: 'Saved login',
          status: 'ok',
          detail: `${credential.email ?? 'unknown account'}${credential.authMethod ? ` (${credential.authMethod})` : ''}`,
        });
        if (credential.expiresAt) {
          const expired = credential.expiresAt <= Date.now();
          checks.push({
            name: 'Access token',
            status: expired ? 'warn' : 'info',
            detail: expired
              ? `expired ${new Date(credential.expiresAt).toISOString()}; agy refreshes it on the next request`
              : `expires ${new Date(credential.expiresAt).toISOString()}`,
          });
        }
      }
    } catch (err) {
      checks.push({ name: 'Saved login', status: 'fail', detail: (err as Error).message });
    }

    for (const k of OVERRIDING_ENV_VARS) {
      if (this.processEnv[k]?.trim()) {
        checks.push({
          name: k,
          status: 'warn',
          detail: 'is set; agy uses it instead of the keyring login, so switching has no visible effect',
        });
      }
    }
    for (const k of Object.keys(this.processEnv)) {
      if (k.startsWith(GATEWAY_ENV_PREFIX) && this.processEnv[k]?.trim()) {
        checks.push({ name: k, status: 'warn', detail: 'is set; agy authenticates through the gateway' });
      }
    }
    for (const k of FILE_FALLBACK_ENV_VARS) {
      if (this.processEnv[k] !== undefined) {
        checks.push({ name: k, status: 'fail', detail: 'is set; agy uses a file credential instead of the keyring' });
      }
    }
    if (this.isRoot()) {
      checks.push({ name: 'Privileges', status: 'fail', detail: 'running as root; agy uses a file credential' });
    }
    checks.push({ name: 'Usage', status: 'info', detail: 'available inside agy with /usage; not managed here' });
    return checks;
  }

  private executable(): string | null {
    return resolveExecutable(this.agyBin, this.processEnv, this.env.platform);
  }

  private isRoot(): boolean {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }

  private async runVersion(bin: string): Promise<ExecResult> {
    if (this.versionFetcher) return this.versionFetcher();
    return run(bin, ['--version'], { env: cleanAgyEnv(this.processEnv), timeoutMs: 30_000 });
  }

  private async runModels(bin: string): Promise<ExecResult> {
    if (this.modelsFetcher) return this.modelsFetcher();
    // `agy models` authenticates (refreshing the OAuth token first) without using model credits.
    return run(bin, ['models'], { env: cleanAgyEnv(this.processEnv), timeoutMs: 120_000 });
  }
}

function accountKey(credential: AgyCredential): string | undefined {
  if (credential.email) return `agy:${credential.email.toLowerCase()}`;
  const token = credential.accessToken ?? credential.refreshToken;
  return token ? `agy:token:${sha256Hex(token).slice(0, 16)}` : undefined;
}

function decodeSnapshot(snapshot: AgySnapshot): Buffer {
  if (!snapshot || snapshot.v !== 1) {
    throw new LockerError('Unsupported Antigravity profile format.', 'E_FORMAT');
  }
  return decodeBase64Field(snapshot.credential, { label: 'Antigravity', maxBytes: MAX_AGY_CREDENTIAL_BYTES });
}

function failureDetail(prefix: string, res: ExecResult): string {
  const line = (res.stderr || res.stdout)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line ? `${prefix}: ${line.slice(0, 300)}` : prefix;
}
