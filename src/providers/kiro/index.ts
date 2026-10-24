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
import { cleanKiroEnv, OVERRIDING_ENV_VARS, resolveKiroEnv, type KiroEnv } from './env.js';
import { findKiroProcesses } from './process.js';
import {
  fetchKiroWhoAmi,
  kiroKeySource,
  parseKiroToken,
  tokenIdentity,
  whoAmiEmail,
  type KiroWhoAmi,
  type KiroWhoAmiResult,
} from './status.js';
import { KiroStore, MAX_KIRO_SNAPSHOT_BYTES, type KiroStoreLike } from './store.js';

/**
 * One Kiro CLI login: the `kirocli:social:token` row, the Identity Center profile row Kiro
 * writes beside it, and the whoami output observed when the snapshot was captured.
 */
export interface KiroSnapshot {
  v: 1;
  /** Base64 of the auth_kv `kirocli:social:token` value. */
  token: string;
  /** Base64 of state `api.codewhisperer.profile`, when present. */
  profile?: string;
  whoami?: KiroWhoAmi | null;
  whoamiError?: string;
}

export interface KiroProviderOptions {
  env?: KiroEnv;
  store?: KiroStoreLike;
  /** Executable name/path, default `kiro-cli` or AI_LOCKER_KIRO_BIN. */
  kiroBin?: string;
  findProcesses?: () => Promise<RunningProcess[]>;
  whoAmiFetcher?: (bin: string) => Promise<KiroWhoAmiResult>;
  versionFetcher?: () => Promise<ExecResult>;
  loginImpl?: (opts: LoginOptions) => Promise<number>;
  processEnv?: NodeJS.ProcessEnv;
}

export class KiroProvider implements Provider<KiroSnapshot> {
  readonly id = 'kiro';
  readonly displayName = 'Kiro CLI';
  readonly loginHint = 'kiro-cli login';
  readonly manualLoginHint = 'For Identity Center or a specific social provider, run `kiro-cli login` with its own flags, then retry.';
  readonly runningHint = 'Kiro CLI session';
  readonly capabilities: ProviderCapabilities = {
    login: { email: false, sso: false, console: false, host: false },
    automatedLogin: true,
    manualLogin: true,
    usage: false,
    // Nothing in the token row is device-bound, so it can move between machines, but only
    // one copy can stay usable: Kiro rotates the refresh token when it renews.
    portableExport: true,
  };
  readonly env: KiroEnv;
  private readonly store: KiroStoreLike;
  private readonly kiroBin: string;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly findProcesses: () => Promise<RunningProcess[]>;
  private readonly whoAmiFetcher?: (bin: string) => Promise<KiroWhoAmiResult>;
  private readonly versionFetcher?: () => Promise<ExecResult>;
  private readonly loginImpl?: (opts: LoginOptions) => Promise<number>;

  constructor(opts: KiroProviderOptions = {}) {
    this.processEnv = opts.processEnv ?? process.env;
    this.kiroBin = opts.kiroBin ?? this.processEnv.AI_LOCKER_KIRO_BIN ?? 'kiro-cli';
    const binPath = opts.kiroBin ? this.kiroBin : resolveExecutable(this.kiroBin, this.processEnv, process.platform);
    this.env = opts.env ?? resolveKiroEnv(this.processEnv, process.platform, undefined, binPath);
    this.store = opts.store ?? new KiroStore(this.env);
    this.findProcesses = opts.findProcesses ?? (() => findKiroProcesses(this.env.platform));
    this.whoAmiFetcher = opts.whoAmiFetcher;
    this.versionFetcher = opts.versionFetcher;
    this.loginImpl = opts.loginImpl;
  }

  describeStore() {
    return { kind: this.store.kind, location: this.store.location };
  }

  async readLive(): Promise<KiroSnapshot | null> {
    const token = await this.store.readToken();
    if (token === null) return null;
    const profile = await this.store.readProfile();
    const who = await this.readWhoAmiSafe();
    return {
      v: 1,
      token: Buffer.from(token, 'utf8').toString('base64'),
      profile: profile === null ? undefined : Buffer.from(profile, 'utf8').toString('base64'),
      whoami: who.whoami,
      whoamiError: who.error,
    };
  }

  async writeLive(snapshot: KiroSnapshot): Promise<void> {
    const { token, profile } = decodeKiroSnapshot(snapshot);
    await this.store.writeRows(token, profile);
  }

  async clearLive(): Promise<void> {
    await this.store.clearRows();
  }

  hasLogin(snapshot: KiroSnapshot): boolean {
    if (!snapshot || typeof snapshot.token !== 'string' || snapshot.token.length === 0) return false;
    let text: string;
    try {
      text = decodeKiroTokenText(snapshot);
    } catch {
      return false;
    }
    const token = parseKiroToken(text);
    return typeof token.access_token === 'string' && token.access_token.length > 0;
  }

  fingerprint(snapshot: KiroSnapshot): string {
    return sha256Hex(`ai-locker-kiro-fp:${snapshot.token}`).slice(0, 16);
  }

  identity(snapshot: KiroSnapshot): Identity {
    let text = '';
    try {
      text = decodeKiroTokenText(snapshot);
    } catch {
      /* fall back to whoami-only identity */
    }
    return tokenIdentity(parseKiroToken(text), snapshot.whoami);
  }

  runningProcesses(): Promise<RunningProcess[]> {
    return this.findProcesses();
  }

  async verifyLive(expected?: Identity): Promise<VerifyResult> {
    const bin = this.executable();
    if (!bin) return { ok: true, skipped: true, detail: '`kiro-cli` not found on PATH; skipped verification' };
    const res = await this.runWhoAmi(bin);
    if (res.error) return { ok: false, detail: res.error };
    if (!res.loggedIn) return { ok: false, detail: 'Kiro CLI reports it is not logged in' };

    const live = await this.readLive().catch(() => null);
    const actual = live ? this.identity(live) : {};
    const email = whoAmiEmail(res.whoami);
    if (
      expected?.accountKey &&
      actual.accountKey &&
      kiroKeySource(expected.accountKey) === kiroKeySource(actual.accountKey) &&
      expected.accountKey !== actual.accountKey
    ) {
      return {
        ok: false,
        email,
        detail: `Kiro CLI holds ${email ?? actual.accountKey}, expected ${expected.email ?? expected.accountKey}`,
      };
    }
    if (expected?.email && email && email.toLowerCase() !== expected.email.toLowerCase()) {
      return { ok: false, email, detail: `Kiro CLI reports ${email}, expected ${expected.email}` };
    }
    return {
      ok: true,
      email,
      detail: email
        ? `logged in as ${email} (${res.whoami?.accountType ?? 'unknown plan'})`
        : `Kiro CLI holds a ${res.whoami?.provider ?? 'unknown'} login but did not name it`,
    };
  }

  async login(opts: LoginOptions): Promise<number> {
    if (opts.email || opts.sso || opts.console || opts.host) {
      throw new LockerError(
        'Kiro CLI login does not accept --email, --sso, --console or --host.',
        'E_ARGS',
        'Run `kiro-cli login` yourself with its provider flags, then `ai-locker --provider kiro add <name>`.',
      );
    }
    if (this.loginImpl) return this.loginImpl(opts);
    const bin = this.executable();
    if (!bin) {
      throw new LockerError('Could not find `kiro-cli`. Is Kiro CLI installed and on PATH?', 'E_NO_KIRO');
    }
    return runInteractive(bin, ['login'], { env: cleanKiroEnv(this.processEnv) });
  }

  async preflight(): Promise<void> {
    const set = OVERRIDING_ENV_VARS.filter((k) => Boolean(this.processEnv[k]?.trim()));
    if (set.length === 0) return;
    throw new LockerError(
      `${set.join(', ')} is set, and Kiro CLI uses it instead of the stored login.`,
      'E_ENV_OVERRIDE',
      `Unset ${set.join(', ')} and retry; otherwise switching accounts has no visible effect.`,
    );
  }

  async validateSnapshot(snapshot: KiroSnapshot): Promise<{ ok: boolean; reason?: string }> {
    try {
      const { token, profile } = decodeKiroSnapshot(snapshot);
      const parsed = parseKiroToken(token);
      if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
        return { ok: false, reason: 'token row has no access_token' };
      }
      if (typeof parsed.refresh_token !== 'string' || !parsed.refresh_token) {
        return { ok: false, reason: 'token row has no refresh_token' };
      }
      if (profile !== null && !isJsonObject(profile)) {
        return { ok: false, reason: 'profile row is not a JSON object' };
      }
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    if (!this.store.exists()) {
      return { ok: false, reason: 'Kiro has no data store on this machine; run `kiro-cli login` once first' };
    }
    return { ok: true };
  }

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    checks.push(
      await cliDoctorCheck({
        label: 'Kiro CLI',
        command: 'kiro-cli',
        bin: this.executable(),
        runVersion: (bin) => this.runVersion(bin),
      }),
    );
    checks.push({
      name: 'Credential store',
      status: this.store.exists() ? 'ok' : 'warn',
      detail: this.store.exists()
        ? `${this.store.kind}: ${this.store.location}`
        : `no database at ${this.store.location}; run \`kiro-cli login\` once to create it`,
    });
    checks.push({ name: 'Data directory', status: 'info', detail: this.env.dataDir });

    if (this.processEnv.KIRO_TEST_DB_PATH) {
      checks.push({ name: 'Store override', status: 'info', detail: `KIRO_TEST_DB_PATH=${this.processEnv.KIRO_TEST_DB_PATH}` });
    }

    for (const k of OVERRIDING_ENV_VARS) {
      if (this.processEnv[k]) {
        checks.push({
          name: k,
          status: 'warn',
          detail: 'is set; Kiro CLI will use it instead of the stored login, so switching has no visible effect',
        });
      }
    }

    const live = await this.readLive().catch((err: Error) => err);
    if (live instanceof Error) {
      checks.push({ name: 'Live login', status: 'fail', detail: live.message });
    } else if (!live || !this.hasLogin(live)) {
      checks.push({ name: 'Live login', status: 'info', detail: 'none' });
    } else {
      const id = this.identity(live);
      checks.push({
        name: 'Live login',
        status: 'ok',
        detail: `${id.email ?? 'email not confirmed'} (${id.plan ?? 'unknown plan'}, ${id.username ?? 'unknown provider'})`,
      });
      if (id.tokenExpiresAt && id.tokenExpiresAt < Date.now()) {
        checks.push({ name: 'Token expiry', status: 'warn', detail: 'stored access token is expired; Kiro should refresh it on next use' });
      }
      if (live.whoamiError) {
        checks.push({ name: 'whoami check', status: 'warn', detail: live.whoamiError });
      }
      if (!id.email) {
        checks.push({ name: 'Account name', status: 'info', detail: 'kiro-cli whoami did not report an email for this login' });
      }
    }

    checks.push({ name: 'Usage', status: 'info', detail: 'not exposed by Kiro CLI' });
    checks.push({ name: 'Kiro IDE', status: 'info', detail: 'not managed; Kiro CLI sign-in only' });
    return checks;
  }

  private executable(): string | null {
    return resolveExecutable(this.kiroBin, this.processEnv, this.env.platform);
  }

  private async runWhoAmi(bin: string): Promise<KiroWhoAmiResult> {
    if (this.whoAmiFetcher) return this.whoAmiFetcher(bin);
    return fetchKiroWhoAmi({ bin, env: this.processEnv });
  }

  private async readWhoAmiSafe(): Promise<KiroWhoAmiResult> {
    const bin = this.executable();
    if (!bin) return { whoami: null, loggedIn: false, code: -1, error: '`kiro-cli` not found on PATH; identity unavailable' };
    try {
      return await this.runWhoAmi(bin);
    } catch (err) {
      return { whoami: null, loggedIn: false, code: -1, error: (err as Error).message };
    }
  }

  private async runVersion(bin: string): Promise<ExecResult> {
    if (this.versionFetcher) return this.versionFetcher();
    return run(bin, ['--version'], { env: cleanKiroEnv(this.processEnv), timeoutMs: 30_000 });
  }
}

function decodeKiroTokenText(snapshot: KiroSnapshot): string {
  return decodeBase64Field(snapshot.token, { label: 'Kiro', maxBytes: MAX_KIRO_SNAPSHOT_BYTES }).toString('utf8');
}

function isJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function decodeKiroSnapshot(snapshot: KiroSnapshot): { token: string; profile: string | null } {
  if (!snapshot || snapshot.v !== 1) {
    throw new LockerError('Unsupported Kiro profile format.', 'E_FORMAT');
  }
  const token = decodeBase64Field(snapshot.token, { label: 'Kiro', maxBytes: MAX_KIRO_SNAPSHOT_BYTES }).toString('utf8');
  if (snapshot.profile === undefined) return { token, profile: null };
  const profile = decodeBase64Field(snapshot.profile, { label: 'Kiro profile', maxBytes: MAX_KIRO_SNAPSHOT_BYTES }).toString('utf8');
  return { token, profile };
}
