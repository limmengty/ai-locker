import { resolveExecutable, run, runInteractive } from '../../util/exec.js';
import { LockerError } from '../../util/errors.js';
import { sha256Hex } from '../../vault/crypto.js';
import { readIfExists } from '../../vault/atomicWrite.js';
import type { DoctorCheck, Identity, LoginOptions, Provider, RunningProcess, UsageReport, VerifyResult } from '../Provider.js';
import { FileStore, KeychainStore, type CredentialStore } from './credentialStore.js';
import { cleanClaudeEnv, OVERRIDING_ENV_VARS, resolveClaudeEnv, type ClaudeEnv } from './env.js';
import { IdentityStore, type OAuthAccount } from './identityStore.js';
import { findClaudeProcesses } from './process.js';
import { fetchUsage } from './usage.js';
import path from 'node:path';

/** Restrict to characters no shell or cmd.exe interprets; it is passed to `claude auth login`. */
export function validateLoginEmail(email: string): string {
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(email)) {
    throw new LockerError(`"${email}" does not look like an email address.`, 'E_ARGS');
  }
  return email;
}

/** Everything that makes up one Claude Code login on this machine. */
export interface ClaudeSnapshot {
  v: 1;
  /** Parsed `.credentials.json` / Keychain JSON: claudeAiOauth, mcpOAuth, organizationUuid... */
  credentials: Record<string, any>;
  /** `oauthAccount` from ~/.claude.json (email, org, account uuid...). */
  oauthAccount: OAuthAccount | null;
}

export interface ClaudeCodeProviderOptions {
  env?: ClaudeEnv;
  store?: CredentialStore;
  /** Executable used for `auth status` / `auth login`. */
  claudeBin?: string;
  findProcesses?: () => Promise<RunningProcess[]>;
  fetchImpl?: typeof fetch;
}

export class ClaudeCodeProvider implements Provider<ClaudeSnapshot> {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly env: ClaudeEnv;
  private readonly store: CredentialStore;
  private readonly identityStore: IdentityStore;
  private readonly claudeBin: string;
  private readonly findProcesses: () => Promise<RunningProcess[]>;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: ClaudeCodeProviderOptions = {}) {
    this.env = opts.env ?? resolveClaudeEnv();
    const file = new FileStore(path.join(this.env.configDir, '.credentials.json'));
    this.store =
      opts.store ??
      (this.env.platform === 'darwin'
        ? new KeychainStore(this.env.keychainService, this.env.keychainAccount, file)
        : file);
    this.identityStore = new IdentityStore(this.env.globalConfigPath);
    this.claudeBin = opts.claudeBin ?? process.env.AI_LOCKER_CLAUDE_BIN ?? 'claude';
    this.findProcesses = opts.findProcesses ?? (() => findClaudeProcesses(this.env.platform));
    this.fetchImpl = opts.fetchImpl;
  }

  describeStore() {
    return { kind: this.store.kind, location: this.store.location };
  }

  async readLive(): Promise<ClaudeSnapshot | null> {
    const text = await this.store.read();
    const oauthAccount = await this.identityStore.read();
    if (text === null) return null;
    let credentials: Record<string, any>;
    try {
      credentials = JSON.parse(text);
    } catch {
      throw new LockerError(
        `Claude Code credentials at ${this.store.location} are not valid JSON; refusing to touch them.`,
        'E_STORE',
      );
    }
    return { v: 1, credentials, oauthAccount };
  }

  async writeLive(snapshot: ClaudeSnapshot): Promise<void> {
    await this.store.write(JSON.stringify(snapshot.credentials));
    await this.identityStore.write(snapshot.oauthAccount);
  }

  async clearLive(): Promise<void> {
    await this.store.clear();
    await this.identityStore.write(null);
  }

  hasLogin(snapshot: ClaudeSnapshot): boolean {
    const o = snapshot.credentials?.claudeAiOauth;
    return Boolean(o && (o.refreshToken || o.accessToken));
  }

  fingerprint(snapshot: ClaudeSnapshot): string {
    const o = snapshot.credentials?.claudeAiOauth ?? {};
    const material = o.refreshToken || o.accessToken || JSON.stringify(snapshot.credentials);
    return sha256Hex(`ai-locker-fp:${material}`).slice(0, 16);
  }

  identity(snapshot: ClaudeSnapshot): Identity {
    const acct = snapshot.oauthAccount ?? {};
    const o = snapshot.credentials?.claudeAiOauth ?? {};
    const accountUuid = typeof acct.accountUuid === 'string' ? acct.accountUuid : undefined;
    const orgUuid =
      (typeof acct.organizationUuid === 'string' ? acct.organizationUuid : undefined) ??
      (typeof snapshot.credentials?.organizationUuid === 'string' ? snapshot.credentials.organizationUuid : undefined);
    return {
      accountKey: accountUuid ? `${accountUuid}:${orgUuid ?? ''}` : undefined,
      email: typeof acct.emailAddress === 'string' ? acct.emailAddress : undefined,
      organization: typeof acct.organizationName === 'string' ? acct.organizationName : undefined,
      plan: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
      tokenExpiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
      refreshExpiresAt: typeof o.refreshTokenExpiresAt === 'number' ? o.refreshTokenExpiresAt : undefined,
    };
  }

  runningProcesses(): Promise<RunningProcess[]> {
    return this.findProcesses();
  }

  /** Path to the `claude` executable, or null if it isn't installed. */
  private claudeExecutable(): string | null {
    return resolveExecutable(this.claudeBin);
  }

  async verifyLive(expected?: Identity): Promise<VerifyResult> {
    const bin = this.claudeExecutable();
    if (!bin) return { ok: true, skipped: true, detail: '`claude` not found on PATH; skipped verification' };
    const res = await run(bin, ['auth', 'status', '--json'], { env: cleanClaudeEnv(), timeoutMs: 60_000 });
    let status: Record<string, unknown> = {};
    try {
      status = JSON.parse(res.stdout);
    } catch {
      return { ok: false, detail: `unexpected output from \`claude auth status\` (exit ${res.code})` };
    }
    if (status.loggedIn !== true) {
      return { ok: false, detail: 'Claude Code reports it is not logged in' };
    }
    const email = typeof status.email === 'string' ? status.email : undefined;
    if (expected?.email && email && email.toLowerCase() !== expected.email.toLowerCase()) {
      return { ok: false, email, detail: `Claude Code reports ${email}, expected ${expected.email}` };
    }
    return { ok: true, email, detail: `logged in${email ? ` as ${email}` : ''} (${String(status.authMethod ?? 'unknown')})` };
  }

  async login(opts: LoginOptions): Promise<number> {
    const args = ['auth', 'login'];
    if (opts.email) args.push('--email', validateLoginEmail(opts.email));
    if (opts.sso) args.push('--sso');
    if (opts.console) args.push('--console');
    const bin = this.claudeExecutable();
    if (!bin) throw new LockerError('Could not find `claude`. Is Claude Code installed and on PATH?', 'E_NO_CLAUDE');
    return runInteractive(bin, args, { env: cleanClaudeEnv() });
  }

  async usage(snapshot: ClaudeSnapshot): Promise<UsageReport> {
    const o = snapshot.credentials?.claudeAiOauth;
    if (!o?.accessToken) return { ok: false, windows: [], error: 'no access token' };
    if (typeof o.expiresAt === 'number' && o.expiresAt < Date.now()) {
      return { ok: false, windows: [], error: 'access token expired; it refreshes the next time this profile is active' };
    }
    return fetchUsage(o.accessToken, this.fetchImpl);
  }

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const bin = this.claudeExecutable();
    if (!bin) {
      checks.push({ name: 'Claude Code', status: 'warn', detail: '`claude` not found on PATH' });
    } else {
      const v = await run(bin, ['--version'], { timeoutMs: 30_000 });
      checks.push(
        v.code === 0
          ? { name: 'Claude Code', status: 'ok', detail: `${v.stdout.trim()} at ${bin}` }
          : { name: 'Claude Code', status: 'warn', detail: `\`${bin} --version\` failed` },
      );
    }
    checks.push({ name: 'Config directory', status: 'info', detail: this.env.configDir });
    checks.push({ name: 'Credential store', status: 'info', detail: `${this.store.kind}: ${this.store.location}` });
    checks.push({ name: 'Account file', status: 'info', detail: this.env.globalConfigPath });

    const live = await this.readLive().catch((err: Error) => err);
    if (live instanceof Error) {
      checks.push({ name: 'Live login', status: 'fail', detail: live.message });
    } else if (!live || !this.hasLogin(live)) {
      checks.push({ name: 'Live login', status: 'info', detail: 'none' });
    } else {
      const id = this.identity(live);
      checks.push({ name: 'Live login', status: 'ok', detail: `${id.email ?? 'unknown email'} (${id.plan ?? 'unknown plan'})` });
      if (!live.oauthAccount) {
        checks.push({
          name: 'Account info',
          status: 'warn',
          detail: 'oauthAccount missing from the account file; profile matching falls back to token fingerprint',
        });
      }
    }

    for (const k of OVERRIDING_ENV_VARS) {
      if (process.env[k]) {
        checks.push({
          name: k,
          status: 'warn',
          detail: 'is set; Claude Code will use it instead of the stored login, so switching has no visible effect',
        });
      }
    }

    if (this.store instanceof KeychainStore) {
      const fallback = await readIfExists(this.store.fallback.location);
      if (fallback) {
        checks.push({
          name: 'Keychain fallback',
          status: 'warn',
          detail: `${this.store.fallback.location} exists; Claude wrote it while the Keychain was locked`,
        });
      }
    }
    return checks;
  }
}
