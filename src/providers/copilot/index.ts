import { resolveExecutable, run, runInteractive, type ExecResult } from '../../util/exec.js';
import { LockerError } from '../../util/errors.js';
import { parseJsonc } from '../../util/jsonc.js';
import { readIfExists } from '../../vault/atomicWrite.js';
import { sha256Hex } from '../../vault/crypto.js';
import {
  keyringBackend,
  type KeyringBackend,
  type KeyringItem,
  type KeyringRef,
} from '../../util/keyring.js';
import type {
  DoctorCheck,
  Identity,
  LoginOptions,
  Provider,
  ProviderCapabilities,
  RunningProcess,
  VerifyResult,
} from '../Provider.js';
import {
  cleanCopilotEnv,
  DISABLING_ENV_VARS,
  OVERRIDING_ENV_VARS,
  resolveCopilotEnv,
  type CopilotEnv,
} from './env.js';
import {
  normalizeHost,
  readActiveUser,
  readCachedIdentity,
  readCopilotConfig,
  readRoster,
  sameUser,
  withActiveUser,
  withoutActiveUser,
  writeCopilotConfig,
} from './config.js';
import { findCopilotProcesses } from './process.js';

const SERVICE = 'copilot-cli';
const GITHUB_ACCOUNT_SUFFIX = ':github';
const CHUNKED_SECRET_PREFIX = 'copilot-keychain-chunks-v1:';
const MAX_SECRET_BYTES = 16 * 1024;

/**
 * Everything that makes up one Copilot CLI login. The CLI keeps the token in the OS
 * keyring (`copilot-cli` service, one item per auth authority) and the roster in config.json.
 */
export interface CopilotCredential {
  /** Keyring account, e.g. `https://github.com:octocat` or `...:octocat:github`. */
  account: string;
  /** Base64 of the raw keyring bytes (UTF-16LE on Windows). */
  token: string;
  persist?: number;
  comment?: string;
}

export interface CopilotSnapshot {
  v: 1;
  host: string;
  login: string;
  /** Roster kind, e.g. `githubDotCom`. */
  kind?: string;
  credentials: CopilotCredential[];
  /** Plan observed from the disposable user cache at capture time. */
  plan?: string;
  sku?: string;
}

export interface CopilotProviderOptions {
  env?: CopilotEnv;
  keyring?: KeyringBackend;
  copilotBin?: string;
  processEnv?: NodeJS.ProcessEnv;
  findProcesses?: () => Promise<RunningProcess[]>;
  fetchImpl?: typeof fetch;
  loginImpl?: (opts: LoginOptions) => Promise<number>;
  versionFetcher?: () => Promise<ExecResult>;
}

export class CopilotProvider implements Provider<CopilotSnapshot> {
  readonly id = 'copilot';
  readonly displayName = 'GitHub Copilot CLI';
  readonly loginHint = 'copilot login';
  readonly manualLoginHint = 'Inside Copilot, run /login, finish the browser sign-in, then quit Copilot.';
  readonly runningHint = 'Copilot CLI session';
  readonly capabilities: ProviderCapabilities = {
    login: { email: false, sso: false, console: false, host: true },
    automatedLogin: true,
    manualLogin: true,
    usage: false,
    portableExport: true,
  };
  readonly env: CopilotEnv;
  private readonly keyring: KeyringBackend;
  private readonly copilotBin: string;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly findProcesses: () => Promise<RunningProcess[]>;
  private readonly fetchImpl: typeof fetch;
  private readonly loginImpl?: (opts: LoginOptions) => Promise<number>;
  private readonly versionFetcher?: () => Promise<ExecResult>;

  constructor(opts: CopilotProviderOptions = {}) {
    this.processEnv = opts.processEnv ?? process.env;
    this.env = opts.env ?? resolveCopilotEnv(this.processEnv);
    this.keyring = opts.keyring ?? keyringBackend(this.env.platform);
    this.copilotBin = opts.copilotBin ?? this.processEnv.AI_LOCKER_COPILOT_BIN ?? 'copilot';
    this.findProcesses = opts.findProcesses ?? (() => findCopilotProcesses(this.env.platform));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.loginImpl = opts.loginImpl;
    this.versionFetcher = opts.versionFetcher;
  }

  describeStore() {
    return {
      kind: `${this.keyring.kind} + config.json`,
      location: `${SERVICE} credentials · ${this.env.configFile}`,
    };
  }

  async readLive(): Promise<CopilotSnapshot | null> {
    const { config } = await readCopilotConfig(this.env);
    const active = readActiveUser(config);
    if (!active) return null;
    const credentials = await this.readCredentials(active.host, active.login);
    if (credentials.length === 0) return null;
    const roster = readRoster(config).find((u) => sameUser(u, active));
    const cached = readCachedIdentity(this.env.userCacheFile, active.login);
    return {
      v: 1,
      host: active.host,
      login: active.login,
      kind: roster?.kind ?? active.kind,
      credentials,
      plan: cached.plan,
      sku: cached.sku,
    };
  }

  async writeLive(snapshot: CopilotSnapshot): Promise<void> {
    const snap = decodeSnapshot(snapshot);
    for (const credential of snap.credentials) {
      const secret = Buffer.from(credential.token, 'base64');
      await this.keyring.write(this.item(credential.account, secret, credential));
    }
    const { text } = await readCopilotConfig(this.env);
    const next = withActiveUser(text, { host: snap.host, login: snap.login, kind: snap.kind });
    if (next !== text) await writeCopilotConfig(this.env, next);
  }

  async clearLive(): Promise<void> {
    const { text, config } = await readCopilotConfig(this.env);
    const active = readActiveUser(config);
    if (!active) return;
    for (const account of credentialAccounts(active.host, active.login)) {
      await this.keyring.delete(this.ref(account));
    }
    if (text !== null) {
      const next = withoutActiveUser(text, active);
      if (next !== text) await writeCopilotConfig(this.env, next);
    }
  }

  hasLogin(snapshot: CopilotSnapshot): boolean {
    return Boolean(
      snapshot &&
        Array.isArray(snapshot.credentials) &&
        snapshot.credentials.some((c) => tokenText(Buffer.from(c.token ?? '', 'base64')) !== null),
    );
  }

  fingerprint(snapshot: CopilotSnapshot): string {
    const parts = (snapshot.credentials ?? [])
      .map((c) => `${c.account}\0${sha256Hex(Buffer.from(c.token ?? '', 'base64'))}`)
      .sort();
    return sha256Hex(
      `ai-locker-copilot-fp:${normalizeHost(snapshot.host ?? '')}\0${snapshot.login ?? ''}\0${parts.join('\0')}`,
    ).slice(0, 16);
  }

  identity(snapshot: CopilotSnapshot): Identity {
    const host = normalizeHost(snapshot.host ?? '');
    const login = (snapshot.login ?? '').trim();
    if (!host || !login) return {};
    return {
      accountKey: accountKey(host, login),
      username: login,
      plan: snapshot.plan ?? snapshot.sku,
    };
  }

  runningProcesses(): Promise<RunningProcess[]> {
    return this.findProcesses();
  }

  async verifyLive(expected?: Identity): Promise<VerifyResult> {
    const { config } = await readCopilotConfig(this.env);
    const active = readActiveUser(config);
    if (!active) return { ok: false, detail: 'Copilot CLI has no active login in config.json' };
    if (expected?.username && expected.username.toLowerCase() !== active.login.toLowerCase()) {
      return {
        ok: false,
        username: active.login,
        detail: `Copilot reports ${active.login}, expected ${expected.username}`,
      };
    }
    if (expected?.accountKey && expected.accountKey !== accountKey(active.host, active.login)) {
      return {
        ok: false,
        username: active.login,
        detail: `Copilot reports ${active.login} at ${active.host}, expected another account`,
      };
    }
    const credentials = await this.readCredentials(active.host, active.login);
    const token = credentials
      .map((c) => tokenText(Buffer.from(c.token, 'base64')))
      .find((t): t is string => t !== null);
    if (!token) {
      return {
        ok: false,
        username: active.login,
        detail: `${SERVICE} has no usable token for ${active.login} (plaintext or chunked storage?)`,
      };
    }
    const result = await this.checkToken(active.host, token);
    if (!result.ok) return { ok: false, username: active.login, detail: result.detail };
    if (result.login && result.login.toLowerCase() !== active.login.toLowerCase()) {
      return {
        ok: false,
        username: active.login,
        detail: `GitHub reports ${result.login}, expected ${active.login}`,
      };
    }
    return {
      ok: true,
      skipped: result.skipped,
      username: active.login,
      detail: result.skipped
        ? `stored token for ${active.login}; ${result.detail}`
        : `logged in as ${active.login}`,
    };
  }

  async login(opts: LoginOptions): Promise<number> {
    if (opts.email || opts.sso || opts.console) {
      throw new LockerError(
        'Copilot CLI login does not support --email, --sso or --console.',
        'E_ARGS',
        'Run `ai-locker --provider copilot add <name>` and choose the account in the browser.',
      );
    }
    if (opts.host) assertHost(opts.host);
    if (this.loginImpl) return this.loginImpl(opts);
    const bin = this.executable();
    if (!bin) {
      throw new LockerError('Could not find `copilot`. Is the Copilot CLI installed and on PATH?', 'E_NO_COPILOT');
    }
    const args = ['login'];
    if (opts.host) args.push('--host', normalizeHost(opts.host));
    return runInteractive(bin, args, { env: cleanCopilotEnv(this.processEnv) });
  }

  async preflight(): Promise<void> {
    const overrides = OVERRIDING_ENV_VARS.filter((k) => Boolean(this.processEnv[k]?.trim()));
    if (overrides.length > 0) {
      throw new LockerError(
        `${overrides.join(', ')} is set, and the Copilot CLI uses it instead of the keyring login.`,
        'E_ENV_OVERRIDE',
        `Unset ${overrides.join(', ')} and retry; otherwise switching accounts has no visible effect.`,
      );
    }
    const disabled = DISABLING_ENV_VARS.filter((k) => this.processEnv[k] !== undefined);
    if (disabled.length > 0) {
      throw new LockerError(
        `${disabled.join(', ')} is set, so Copilot may not use the OS keyring.`,
        'E_COPILOT_KEYTAR',
        `Unset ${disabled.join(', ')} and retry.`,
      );
    }
    if (await this.plaintextStorage()) {
      throw new LockerError(
        'Copilot is configured to store its token in plaintext (`storeTokenPlaintext`).',
        'E_COPILOT_PLAINTEXT',
        'Set "storeTokenPlaintext": false in Copilot settings, log in again, then retry.',
      );
    }
    const availability = await this.keyring.available();
    if (!availability.ok) {
      throw new LockerError(`No OS credential store available: ${availability.detail}`, 'E_KEYRING');
    }
  }

  async validateSnapshot(snapshot: CopilotSnapshot): Promise<{ ok: boolean; reason?: string }> {
    try {
      decodeSnapshot(snapshot);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const bin = this.executable();
    if (!bin) {
      checks.push({ name: 'Copilot CLI', status: 'warn', detail: '`copilot` not found on PATH' });
    } else {
      const version = await this.runVersion(bin);
      checks.push(
        version.code === 0
          ? { name: 'Copilot CLI', status: 'ok', detail: `${version.stdout.trim() || 'installed'} at ${bin}` }
          : { name: 'Copilot CLI', status: 'warn', detail: `\`${bin} --version\` failed` },
      );
    }
    checks.push({ name: 'Config directory', status: 'info', detail: this.env.configDir });

    const availability = await this.keyring.available();
    checks.push({
      name: 'Credential store',
      status: availability.ok ? 'ok' : 'fail',
      detail: `${this.keyring.kind}: ${availability.detail}`,
    });

    const settings = await this.plaintextStorage().catch((err: Error) => err);
    if (settings instanceof Error) {
      checks.push({ name: 'Token storage', status: 'fail', detail: settings.message });
    } else if (settings) {
      checks.push({
        name: 'Token storage',
        status: 'fail',
        detail: 'plaintext storage is enabled; ai-locker cannot capture or switch this login',
      });
    } else {
      checks.push({ name: 'Token storage', status: 'ok', detail: 'OS keyring' });
    }

    for (const k of OVERRIDING_ENV_VARS) {
      if (this.processEnv[k]?.trim()) {
        checks.push({
          name: k,
          status: 'warn',
          detail: 'is set; Copilot uses it instead of the keyring login, so switching has no visible effect',
        });
      }
    }
    for (const k of DISABLING_ENV_VARS) {
      if (this.processEnv[k] !== undefined) {
        checks.push({ name: k, status: 'fail', detail: 'is set; Copilot may not use the OS keyring' });
      }
    }

    const live = await this.readLive().catch((err: Error) => err);
    if (live instanceof Error) {
      checks.push({ name: 'Live login', status: 'fail', detail: live.message });
    } else if (!live) {
      checks.push({ name: 'Live login', status: 'info', detail: 'none' });
    } else {
      checks.push({
        name: 'Live login',
        status: 'ok',
        detail: `${live.login} at ${live.host}${live.plan ? ` (${live.plan})` : ''}`,
      });
      checks.push({ name: 'Keyring items', status: 'info', detail: live.credentials.map((c) => c.account).join(', ') });
    }
    checks.push({ name: 'Usage', status: 'info', detail: 'available inside Copilot with /usage; not managed here' });
    return checks;
  }

  private ref(account: string): KeyringRef {
    return { service: SERVICE, account, windowsTarget: `${account}.${SERVICE}` };
  }

  private item(account: string, secret: Buffer, extra: { persist?: number; comment?: string } = {}): KeyringItem {
    return {
      ...this.ref(account),
      secret,
      persist: extra.persist ?? 3,
      comment: extra.comment,
      label: `Copilot CLI (${account})`,
    };
  }

  private async readCredentials(host: string, login: string): Promise<CopilotCredential[]> {
    const out: CopilotCredential[] = [];
    for (const account of credentialAccounts(host, login)) {
      const entry = await this.keyring.read(this.ref(account));
      if (!entry || tokenText(entry.secret) === null) continue;
      out.push({
        account,
        token: entry.secret.toString('base64'),
        persist: entry.persist,
        comment: entry.comment,
      });
    }
    return out;
  }

  private async plaintextStorage(): Promise<boolean> {
    const text = await readIfExists(this.env.settingsFile);
    if (text === null || !text.trim()) return false;
    let settings: unknown;
    try {
      settings = parseJsonc(text);
    } catch (err) {
      throw new LockerError(
        `Copilot's settings file is invalid: ${(err as Error).message}`,
        'E_COPILOT_CONFIG',
        `Fix or remove ${this.env.settingsFile}, then retry.`,
      );
    }
    return Boolean(settings && typeof settings === 'object' && (settings as Record<string, unknown>).storeTokenPlaintext === true);
  }

  private async checkToken(
    host: string,
    token: string,
  ): Promise<{ ok: boolean; skipped?: boolean; login?: string; detail: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(apiUrl(host), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ai-locker',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      return { ok: true, skipped: true, detail: `could not reach ${apiUrl(host)} (${(err as Error).message})` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `GitHub rejected the saved token (HTTP ${res.status})` };
    }
    if (res.status !== 200) {
      return { ok: true, skipped: true, detail: `GitHub returned HTTP ${res.status}; could not verify` };
    }
    try {
      const body = (await res.json()) as { login?: unknown };
      if (typeof body.login === 'string' && body.login) return { ok: true, login: body.login, detail: 'ok' };
    } catch {
      /* fall through */
    }
    return { ok: true, skipped: true, detail: 'GitHub user lookup returned no login' };
  }

  private executable(): string | null {
    return resolveExecutable(this.copilotBin, this.processEnv, this.env.platform);
  }

  private async runVersion(bin: string): Promise<ExecResult> {
    if (this.versionFetcher) return this.versionFetcher();
    return run(bin, ['--version'], { env: cleanCopilotEnv(this.processEnv), timeoutMs: 30_000 });
  }
}

function accountKey(host: string, login: string): string {
  return `copilot:${normalizeHost(host).toLowerCase()}:${login.toLowerCase()}`;
}

function credentialAccounts(host: string, login: string): string[] {
  const base = `${normalizeHost(host)}:${login}`;
  return [base, `${base}${GITHUB_ACCOUNT_SUFFIX}`];
}

function apiUrl(host: string): string {
  const normalized = normalizeHost(host);
  return normalized.toLowerCase() === 'https://github.com'
    ? 'https://api.github.com/user'
    : `${normalized}/api/v3/user`;
}

/** Keytar stores strings as UTF-16LE on Windows; tokens are printable ASCII or UTF-8. */
function tokenText(secret: Buffer): string | null {
  if (secret.length === 0 || secret.length > MAX_SECRET_BYTES) return null;
  const text = secretText(secret).trim();
  if (isChunked(secret)) return null;
  return /^[A-Za-z0-9_.~+/=-]+$/.test(text) ? text : null;
}

function secretText(secret: Buffer): string {
  return (secret.length > 1 && secret[1] === 0 ? secret.toString('utf16le') : secret.toString('utf8')).replace(
    /\0+$/g,
    '',
  );
}

function isChunked(secret: Buffer): boolean {
  return secretText(secret).startsWith(CHUNKED_SECRET_PREFIX);
}

function assertHost(host: string): void {
  if (!/^https:\/\/[^\s"'<>\\]+$/i.test(host.trim())) {
    throw new LockerError(`"${host}" is not a valid https host.`, 'E_ARGS', 'Pass the GitHub host, e.g. https://github.com.');
  }
}

function decodeSnapshot(snapshot: CopilotSnapshot): CopilotSnapshot {
  if (!snapshot || snapshot.v !== 1) {
    throw new LockerError('Unsupported Copilot profile format.', 'E_FORMAT');
  }
  const host = typeof snapshot.host === 'string' ? normalizeHost(snapshot.host) : '';
  const login = typeof snapshot.login === 'string' ? snapshot.login.trim() : '';
  if (!host || !login) throw new LockerError('Copilot profile is missing its account.', 'E_FORMAT');
  if (!Array.isArray(snapshot.credentials) || snapshot.credentials.length === 0) {
    throw new LockerError('Copilot profile has no credentials.', 'E_FORMAT');
  }
  const prefix = `${host}:${login}`;
  const seen = new Set<string>();
  const credentials: CopilotCredential[] = [];
  for (const raw of snapshot.credentials) {
    if (!raw || typeof raw !== 'object') throw new LockerError('Copilot profile has a malformed credential.', 'E_FORMAT');
    const account = typeof raw.account === 'string' ? raw.account : '';
    const token = typeof raw.token === 'string' ? raw.token : '';
    if (!account || !token) throw new LockerError('Copilot profile has a malformed credential.', 'E_FORMAT');
    if (account !== prefix && !account.startsWith(`${prefix}:`)) {
      throw new LockerError('Copilot profile contains a credential for a different account.', 'E_FORMAT');
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) {
      throw new LockerError('Copilot profile token is not valid base64.', 'E_FORMAT');
    }
    const secret = Buffer.from(token, 'base64');
    if (secret.length === 0 || secret.length > MAX_SECRET_BYTES) {
      throw new LockerError('Copilot profile token has an invalid size.', 'E_FORMAT');
    }
    if (isChunked(secret)) {
      throw new LockerError(
        'This Copilot login uses chunked keychain entries, which ai-locker cannot capture.',
        'E_COPILOT_UNSUPPORTED',
      );
    }
    if (seen.has(account)) continue;
    seen.add(account);
    credentials.push({
      account,
      token,
      persist: Number.isInteger(raw.persist) ? raw.persist : undefined,
      comment: typeof raw.comment === 'string' ? raw.comment : undefined,
    });
  }
  if (!credentials.some((c) => tokenText(Buffer.from(c.token, 'base64')) !== null)) {
    throw new LockerError('Copilot profile does not contain a usable token.', 'E_FORMAT');
  }
  return {
    v: 1,
    host,
    login,
    kind: typeof snapshot.kind === 'string' && snapshot.kind ? snapshot.kind : undefined,
    credentials,
    plan: typeof snapshot.plan === 'string' ? snapshot.plan : undefined,
    sku: typeof snapshot.sku === 'string' ? snapshot.sku : undefined,
  };
}
