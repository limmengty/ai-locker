import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockerPaths } from '../src/util/paths.js';
import { Vault } from '../src/vault/vault.js';
import { ClaudeCodeProvider, type ClaudeSnapshot } from '../src/providers/claude-code/index.js';
import { FileStore } from '../src/providers/claude-code/credentialStore.js';
import { QoderProvider, type QoderSnapshot } from '../src/providers/qoder/index.js';
import { QoderStore } from '../src/providers/qoder/store.js';
import type { QoderStatus } from '../src/providers/qoder/status.js';
import { CopilotProvider, type CopilotSnapshot } from '../src/providers/copilot/index.js';
import type { CopilotEnv } from '../src/providers/copilot/env.js';
import { parseCopilotConfig, readActiveUser, withActiveUser } from '../src/providers/copilot/config.js';
import { AgyProvider } from '../src/providers/antigravity/index.js';
import { KiroProvider } from '../src/providers/kiro/index.js';
import type { KiroEnv } from '../src/providers/kiro/env.js';
import type { KiroStoreLike } from '../src/providers/kiro/store.js';
import type { KiroWhoAmi } from '../src/providers/kiro/status.js';
import { resolveAgyEnv, type AgyEnv } from '../src/providers/antigravity/env.js';
import { parseAgyCredential } from '../src/providers/antigravity/credential.js';
import type {
  KeyringBackend,
  KeyringEntry,
  KeyringItem,
  KeyringRef,
} from '../src/util/keyring.js';
import type { Identity, RunningProcess, VerifyResult } from '../src/providers/Provider.js';
import type { KdfParams } from '../src/vault/crypto.js';

export const PASS = 'correct horse battery staple';

/** Cheap KDF so tests stay fast; production defaults are exercised in crypto.test.ts. */
export const FAST_KDF: KdfParams = { name: 'scrypt', N: 2 ** 10, r: 8, p: 1, salt: Buffer.alloc(16, 7).toString('base64') };

export function tempDir(prefix = 'ai-locker-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function newVault(home = tempDir()) {
  const paths = lockerPaths(path.join(home, 'locker'));
  const { vault } = await Vault.create(paths, PASS, { osUnlock: false, kdf: FAST_KDF });
  return { vault, paths };
}

export function creds(tag: string, extra: Record<string, unknown> = {}) {
  return {
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-${tag}-access`,
      refreshToken: `sk-ant-ort01-${tag}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86_400_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
    mcpOAuth: {},
    organizationUuid: `org-${tag}`,
    ...extra,
  };
}

export function account(tag: string) {
  return {
    accountUuid: `acct-${tag}`,
    emailAddress: `${tag}@example.com`,
    organizationUuid: `org-${tag}`,
    organizationName: `${tag}'s Organization`,
    displayName: tag,
  };
}

/** A fake Claude Code install: config dir + global config file in a temp directory. */
export class FakeClaude {
  readonly root = tempDir('ai-locker-claude-');
  readonly configDir = path.join(this.root, '.claude');
  readonly globalConfig = path.join(this.root, '.claude.json');
  readonly credFile = path.join(this.configDir, '.credentials.json');
  running: RunningProcess[] = [];
  verifyResult: VerifyResult | null = null;
  /** Simulates `claude auth login` writing a new account. */
  nextLogin: string | null = null;

  constructor() {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(
      this.globalConfig,
      JSON.stringify({ numStartups: 5, projects: { '/x': { allowedTools: [] } }, userID: 'device-1' }, null, 2) + '\n',
    );
  }

  loginAs(tag: string, credsOverride?: Record<string, unknown>) {
    fs.writeFileSync(this.credFile, JSON.stringify(credsOverride ?? creds(tag)));
    const g = JSON.parse(fs.readFileSync(this.globalConfig, 'utf8'));
    g.oauthAccount = account(tag);
    fs.writeFileSync(this.globalConfig, JSON.stringify(g, null, 2) + '\n');
  }

  /** What Claude Code does every hour: rotate both tokens in place. */
  rotate(tag: string, n: number) {
    const cur = JSON.parse(fs.readFileSync(this.credFile, 'utf8'));
    cur.claudeAiOauth.accessToken = `sk-ant-oat01-${tag}-access-r${n}`;
    cur.claudeAiOauth.refreshToken = `sk-ant-ort01-${tag}-refresh-r${n}`;
    fs.writeFileSync(this.credFile, JSON.stringify(cur));
  }

  liveCreds(): any {
    return fs.existsSync(this.credFile) ? JSON.parse(fs.readFileSync(this.credFile, 'utf8')) : null;
  }

  globalJson(): any {
    return JSON.parse(fs.readFileSync(this.globalConfig, 'utf8'));
  }

  provider(): ClaudeCodeProvider {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fake = this;
    return new (class extends ClaudeCodeProvider {
      async verifyLive(expected?: Identity): Promise<VerifyResult> {
        if (fake.verifyResult) return fake.verifyResult;
        const live = await this.readLive();
        const email = live ? this.identity(live).email : undefined;
        if (!live || !this.hasLogin(live)) return { ok: false, detail: 'not logged in' };
        if (expected?.email && email !== expected.email) return { ok: false, detail: `got ${email}` };
        return { ok: true, email, detail: 'ok' };
      }
      async login(): Promise<number> {
        if (!fake.nextLogin) return 1;
        fake.loginAs(fake.nextLogin);
        return 0;
      }
    })({
      env: {
        platform: process.platform,
        configDir: this.configDir,
        globalConfigPath: this.globalConfig,
        keychainService: 'unused',
        keychainAccount: 'unused',
      },
      store: new FileStore(this.credFile),
      findProcesses: async () => fake.running,
    });
  }
}

export type { ClaudeSnapshot, QoderSnapshot };
export type { CopilotSnapshot };

function qoderUid(tag: string): string {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `00000000-0000-4000-8000-${h.toString(16).padStart(12, '0').slice(-12)}`;
}

export function qoderStatus(tag: string, extra: Partial<QoderStatus> = {}): QoderStatus {
  return {
    logged_in: true,
    version: '1.1.78',
    allow_byok: 0,
    auth_source: 'stored',
    account_type: 'personal',
    login_method: 'browser',
    username: tag,
    email: `${tag}@example.com`,
    avatar_url: `https://cdn.qoder.com/users/${qoderUid(tag)}/avatar.png`,
    user_type: 'pro',
    ...extra,
  };
}

/** Synthetic credential blob: opaque to the provider, but reveals its tag to the fake status command. */
function qoderBlob(tag: string, revision = 0): string {
  return JSON.stringify({ v: 1, tag, revision, opaque: `qoder-${tag}-${revision}` });
}

/** A fake Qoder CLI install: config dir, machine id, credential blob, and a status command. */
export class FakeQoder {
  readonly root = tempDir('ai-locker-qoder-');  readonly configDir = path.join(this.root, '.qoder');
  readonly authDir = path.join(this.configDir, '.auth');
  readonly userFile = path.join(this.authDir, 'user');
  readonly machineIdFile = path.join(this.authDir, 'machine_id');
  readonly bin: string;
  running: RunningProcess[] = [];
  /** Written by a simulated `qodercli login`; null makes the login fail. */
  nextLogin: string | null = null;
  /** Overrides what `qodercli status` reports. */
  statusOverride: QoderStatus | null = null;
  statusError: string | null = null;
  loginCalls = 0;

  constructor(machineId = '11111111-2222-4333-8444-555555555555') {
    fs.mkdirSync(this.authDir, { recursive: true });
    fs.writeFileSync(this.machineIdFile, `${machineId}\n`);
    this.bin = path.join(this.root, process.platform === 'win32' ? 'qodercli.exe' : 'qodercli');
    fs.writeFileSync(this.bin, '');
  }

  loginAs(tag: string) {
    fs.writeFileSync(this.userFile, qoderBlob(tag));
  }

  rotate(tag: string, revision: number) {
    fs.writeFileSync(this.userFile, qoderBlob(tag, revision));
  }

  currentTag(): string | null {
    if (!fs.existsSync(this.userFile)) return null;
    return JSON.parse(fs.readFileSync(this.userFile, 'utf8')).tag;
  }

  env() {
    return {
      platform: process.platform,
      configDir: this.configDir,
      authDir: this.authDir,
      userFile: this.userFile,
      machineIdFile: this.machineIdFile,
      transactionFile: path.join(this.authDir, '.credential-transaction'),
    };
  }

  provider(processEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' }): QoderProvider {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fake = this;
    const env = this.env();
    return new QoderProvider({
      env,
      store: new QoderStore(env),
      qoderBin: this.bin,
      processEnv,
      findProcesses: async () => fake.running,
      statusFetcher: async () => {
        if (fake.statusError) return { status: null, code: 1, error: fake.statusError };
        if (fake.statusOverride) return { status: fake.statusOverride, code: 0 };
        const tag = fake.currentTag();
        if (!tag) return { status: { logged_in: false }, code: 0 };
        return { status: qoderStatus(tag), code: 0 };
      },
      versionFetcher: async () => ({ code: 0, stdout: '1.1.78\n', stderr: '' }),
      loginImpl: async () => {
        fake.loginCalls += 1;
        if (!fake.nextLogin) return 1;
        fake.loginAs(fake.nextLogin);
        return 0;
      },
    });
  }
}
/** In-memory stand-in for the OS keyring. */
export class MemoryKeyring implements KeyringBackend {
  readonly kind = 'memory keyring';
  readonly items = new Map<string, { secret: Buffer; comment?: string; persist?: number }>();

  private key(ref: KeyringRef): string {
    return ref.windowsTarget ?? `${ref.account}.${ref.service}`;
  }

  async available() {
    return { ok: true, detail: 'memory' };
  }

  async read(ref: KeyringRef): Promise<KeyringEntry | null> {
    const item = this.items.get(this.key(ref));
    return item ? { ...ref, ...item, secret: Buffer.from(item.secret) } : null;
  }

  async write(item: KeyringItem): Promise<void> {
    this.items.set(this.key(item), {
      secret: Buffer.from(item.secret),
      comment: item.comment,
      persist: item.persist,
    });
  }

  async delete(ref: KeyringRef): Promise<boolean> {
    return this.items.delete(this.key(ref));
  }
}

const COPILOT_CONFIG_HEADER = `// User settings belong in settings.json.
// This file is managed automatically.
`;

/** A fake Copilot CLI install: JSONC roster in a temp dir plus an in-memory keyring. */
export class FakeCopilot {
  readonly root = tempDir('ai-locker-copilot-');
  readonly configDir = path.join(this.root, '.copilot');
  readonly configFile = path.join(this.configDir, 'config.json');
  readonly settingsFile = path.join(this.configDir, 'settings.json');
  readonly cacheFile = path.join(this.root, 'cache', 'copilot-user-cache.json');
  readonly env: CopilotEnv = {
    platform: process.platform,
    configDir: this.configDir,
    configFile: this.configFile,
    settingsFile: this.settingsFile,
    userCacheFile: this.cacheFile,
  };
  readonly keyring = new MemoryKeyring();
  readonly bin: string;
  running: RunningProcess[] = [];
  nextLogin: string | null = null;
  loginCalls = 0;
  verifyStatus: number | null = null;
  verifyError: string | null = null;
  private readonly plans = new Map<string, string>();

  constructor(host = 'https://github.com') {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.configFile, `${COPILOT_CONFIG_HEADER}{}\n`);
    this.bin = path.join(this.root, process.platform === 'win32' ? 'copilot.exe' : 'copilot');
    fs.writeFileSync(this.bin, '');
    this.host = host;
  }

  readonly host: string;

  loginAs(login: string, opts: { host?: string; kind?: string; revision?: number; plan?: string } = {}) {
    const host = opts.host ?? this.host;
    const text = fs.existsSync(this.configFile) ? fs.readFileSync(this.configFile, 'utf8') : `${COPILOT_CONFIG_HEADER}{}\n`;
    fs.writeFileSync(
      this.configFile,
      withActiveUser(text, { host, login, kind: opts.kind ?? (host === 'https://github.com' ? 'githubDotCom' : undefined) }),
    );
    this.writeCredentials(host, login, opts.revision ?? 0);
    this.plans.set(login, opts.plan ?? 'individual');
    this.writeCache();
  }

  rotate(login: string, revision: number, host = this.host) {
    this.writeCredentials(host, login, revision);
  }

  currentTag(): string | null {
    if (!fs.existsSync(this.configFile)) return null;
    return readActiveUser(parseCopilotConfig(fs.readFileSync(this.configFile, 'utf8')))?.login ?? null;
  }

  configText(): string {
    return fs.readFileSync(this.configFile, 'utf8');
  }

  provider(processEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' }): CopilotProvider {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fake = this;
    return new CopilotProvider({
      env: this.env,
      keyring: this.keyring,
      copilotBin: this.bin,
      processEnv,
      findProcesses: async () => fake.running,
      fetchImpl: async () => {
        if (fake.verifyError) throw new Error(fake.verifyError);
        if (fake.verifyStatus && fake.verifyStatus !== 200) {
          return new Response('{}', { status: fake.verifyStatus });
        }
        return new Response(JSON.stringify({ login: fake.currentTag() ?? 'unknown' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      loginImpl: async () => {
        fake.loginCalls += 1;
        if (!fake.nextLogin) return 1;
        fake.loginAs(fake.nextLogin);
        return 0;
      },
      versionFetcher: async () => ({ code: 0, stdout: '1.0.103\n', stderr: '' }),
    });
  }

  private writeCredentials(host: string, login: string, revision: number) {
    const token = `gho_${login}_revision_${revision}_${'x'.repeat(20)}`;
    for (const account of [`${host}:${login}`, `${host}:${login}:github`]) {
      void this.keyring.write({
        service: 'copilot-cli',
        account,
        windowsTarget: `${account}.copilot-cli`,
        secret: Buffer.from(token, 'utf16le'),
        persist: 3,
      });
    }
  }

  private writeCache() {
    const cache: Record<string, unknown> = {};
    for (const [login, plan] of this.plans) {
      cache[`v1:${login}`] = {
        retrievedAt: new Date().toISOString(),
        response: { login, copilot_plan: plan, access_type_sku: `${plan}_sku` },
      };
    }
    fs.writeFileSync(this.cacheFile, JSON.stringify({ copilotUserCache: cache }, null, 2));
  }
}

/** A fake Antigravity install: keyring-only credential plus a `agy models` stub. */
export class FakeAgy {
  readonly root = tempDir('ai-locker-agy-');
  readonly home = path.join(this.root, 'home');
  readonly env: AgyEnv = resolveAgyEnv(process.platform, this.home);
  readonly keyring = new MemoryKeyring();
  readonly bin: string;
  running: RunningProcess[] = [];
  modelsCode = 0;
  modelsOutput = 'gemini-3-pro\n';
  modelsError = '';
  modelsCalls = 0;
  loginImpl?: () => Promise<number>;

  constructor() {
    fs.mkdirSync(this.home, { recursive: true });
    this.bin = path.join(this.root, process.platform === 'win32' ? 'agy.exe' : 'agy');
    fs.writeFileSync(this.bin, '');
  }

  loginAs(email: string, opts: { revision?: number; authMethod?: string; expiresAt?: number } = {}) {
    const revision = opts.revision ?? 0;
    const expiry = new Date(opts.expiresAt ?? Date.now() + 3_600_000).toISOString();
    const blob = {
      auth_method: opts.authMethod ?? 'oauth',
      id_token_email: email,
      token: {
        access_token: `ya29.${email}.revision_${revision}`,
        expires_in: 3599,
        expiry,
        refresh_token: `1//refresh.${email}`,
        token_type: 'Bearer',
      },
    };
    void this.keyring.write({
      service: 'gemini',
      account: 'antigravity',
      windowsTarget: 'gemini:antigravity',
      secret: Buffer.from(JSON.stringify(blob), 'utf8'),
      persist: 2,
    });
  }

  rotate(email: string, revision: number) {
    this.loginAs(email, { revision });
  }

  currentEmail(): string | null {
    const item = this.keyring.items.get('gemini:antigravity');
    if (!item) return null;
    return parseAgyCredential(item.secret).email ?? null;
  }

  credentialText(): string | null {
    const item = this.keyring.items.get('gemini:antigravity');
    return item ? item.secret.toString('utf8') : null;
  }

  provider(processEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' }): AgyProvider {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fake = this;
    return new AgyProvider({
      env: this.env,
      keyring: this.keyring,
      agyBin: this.bin,
      processEnv,
      findProcesses: async () => fake.running,
      versionFetcher: async () => ({ code: 0, stdout: '1.4.7\n', stderr: '' }),
      modelsFetcher: async () => {
        fake.modelsCalls += 1;
        return { code: fake.modelsCode, stdout: fake.modelsOutput, stderr: fake.modelsError };
      },
      ...(this.loginImpl ? { loginImpl: () => this.loginImpl!() } : {}),
    });
  }
}

/** The JSON Kiro stores in its `auth_kv` row. */
export function kiroTokenBlob(tag: string, revision = 0): string {
  return JSON.stringify({
    access_token: `kiro-at-${tag}-${revision}`,
    refresh_token: `kiro-rt-${tag}-${revision}`,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    provider: 'google',
    profile_arn: `arn:aws:codewhisperer:us-east-1:111111111111:profile/${tag}`,
  });
}

export function kiroWhoAmi(tag: string): KiroWhoAmi {
  return { accountType: 'Pro', provider: 'Google', email: `${tag}@example.com` };
}

function kiroTagOf(token: string | null): string | null {
  if (!token) return null;
  try {
    const at = (JSON.parse(token) as { access_token?: string }).access_token ?? '';
    return /^kiro-at-(.+)-\d+$/.exec(at)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A fake Kiro install: the two database rows the CLI keeps, plus a scripted whoami. */
export class FakeKiro {
  readonly root = tempDir('ai-locker-kiro-');
  readonly dbFile = path.join(this.root, 'data.sqlite3');
  readonly bin: string;
  token: string | null = null;
  profile: string | null = null;
  /** False simulates a machine where kiro-cli has never run. */
  storeExists = true;
  running: RunningProcess[] = [];
  whoAmi: KiroWhoAmi | null = null;
  whoAmiError: string | null = null;
  /** Simulates `kiro-cli login` writing a new account; null makes the login fail. */
  nextLogin: string | null = null;
  loginCalls = 0;

  constructor() {
    this.bin = path.join(this.root, process.platform === 'win32' ? 'kiro-cli.exe' : 'kiro-cli');
    fs.writeFileSync(this.bin, '');
  }

  loginAs(tag: string) {
    this.token = kiroTokenBlob(tag);
    this.profile = JSON.stringify({ arn: `arn:aws:codewhisperer:us-east-1:111111111111:profile/${tag}`, profile_name: tag });
    this.whoAmi = kiroWhoAmi(tag);
    this.storeExists = true;
  }

  rotate(tag: string, revision: number) {
    this.token = kiroTokenBlob(tag, revision);
    this.whoAmi = kiroWhoAmi(tag);
  }

  currentTag(): string | null {
    return kiroTagOf(this.token);
  }

  env(): KiroEnv {
    return {
      platform: process.platform,
      home: this.root,
      dataDir: this.root,
      dbFile: this.dbFile,
      settingsDir: path.join(this.root, '.kiro'),
    };
  }

  private store(): KiroStoreLike {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fake = this;
    return {
      kind: 'memory sqlite',
      get location() {
        return fake.dbFile;
      },
      exists: () => fake.storeExists,
      readToken: async () => fake.token,
      readProfile: async () => fake.profile,
      writeRows: async (token: string, profile: string | null) => {
        fake.token = token;
        fake.profile = profile;
        fake.storeExists = true;
        const tag = kiroTagOf(token);
        fake.whoAmi = tag ? kiroWhoAmi(tag) : { account: null };
      },
      clearRows: async () => {
        fake.token = null;
        fake.profile = null;
        fake.whoAmi = { account: null };
      },
    };
  }

  provider(processEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' }): KiroProvider {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fake = this;
    return new KiroProvider({
      env: this.env(),
      store: this.store(),
      kiroBin: this.bin,
      processEnv,
      findProcesses: async () => fake.running,
      whoAmiFetcher: async () => {
        if (fake.whoAmiError) return { whoami: null, loggedIn: false, code: 1, error: fake.whoAmiError };
        const whoami = fake.whoAmi ?? (fake.currentTag() ? kiroWhoAmi(fake.currentTag() as string) : { account: null });
        return { whoami, loggedIn: Boolean(whoami.accountType || whoami.provider), code: 0 };
      },
      versionFetcher: async () => ({ code: 0, stdout: 'kiro-cli-chat 2.16.0\n', stderr: '' }),
      loginImpl: async () => {
        fake.loginCalls += 1;
        if (!fake.nextLogin) return 1;
        fake.loginAs(fake.nextLogin);
        fake.nextLogin = null;
        return 0;
      },
    });
  }
}
