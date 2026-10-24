import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanKiroEnv, OVERRIDING_ENV_VARS, resolveKiroEnv } from '../src/providers/kiro/env.js';
import { isKiroProcess } from '../src/providers/kiro/process.js';
import { parseKiroToken, tokenIdentity } from '../src/providers/kiro/status.js';
import { type KiroSnapshot } from '../src/providers/kiro/index.js';
import { KiroStore } from '../src/providers/kiro/store.js';
import { getProvider } from '../src/providers/index.js';
import { addFromLive, addViaLogin, lockLive, switchTo } from '../src/core/switchService.js';
import { requireProfile } from '../src/core/profiles.js';
import { exportProfiles, importProfiles } from '../src/core/transfer.js';
import { FakeKiro, newVault } from './helpers.js';

async function setup() {
  const fake = new FakeKiro();
  const { vault } = await newVault();
  return { fake, vault, ctx: { vault, provider: fake.provider() } };
}

describe('Kiro environment', () => {
  it('puts data.sqlite3 next to the kiro-cli binary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-env-'));
    const env = resolveKiroEnv({}, process.platform, os.homedir(), path.join(dir, 'kiro-cli'));
    expect(env.dbFile).toBe(path.join(dir, 'data.sqlite3'));
    expect(env.dataDir).toBe(dir);
  });

  it('honours KIRO_TEST_DB_PATH and KIRO_HOME', () => {
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-env-')), 'sandbox.sqlite3');
    const env = resolveKiroEnv({ KIRO_TEST_DB_PATH: db }, process.platform, os.homedir(), null);
    expect(env.dbFile).toBe(path.resolve(db));
    expect(env.dataDir).toBe(path.dirname(path.resolve(db)));

    const home = path.resolve(os.tmpdir(), 'kiro-home-test');
    expect(resolveKiroEnv({ KIRO_HOME: home }, process.platform, os.homedir(), null).settingsDir).toBe(home);
    expect(resolveKiroEnv({}, process.platform, '/home/me', null).settingsDir).toBe(path.join('/home/me', '.kiro'));
  });

  it('strips the API-key override before spawning kiro-cli', () => {
    const env = cleanKiroEnv({ PATH: '/bin', KIRO_API_KEY: 'secret', KIRO_NO_AUTO_UPDATE: '1' });
    expect(env.PATH).toBe('/bin');
    expect(env.KIRO_NO_AUTO_UPDATE).toBe('1');
    for (const key of OVERRIDING_ENV_VARS) expect(env[key]).toBeUndefined();
  });
});

describe('Kiro process detection', () => {
  it('recognises the native binary and the bun-hosted TUI', () => {
    expect(isKiroProcess({ pid: 1, name: 'kiro-cli.exe', commandLine: '' })).toBe(true);
    expect(isKiroProcess({ pid: 1, name: '/usr/local/bin/kiro-cli', commandLine: '' })).toBe(true);
    expect(isKiroProcess({ pid: 1, name: 'kiro-cli-chat.exe', commandLine: '' })).toBe(true);
    expect(isKiroProcess({ pid: 1, name: 'kiro-cli-internal-auth.exe', commandLine: '' })).toBe(true);
    expect(
      isKiroProcess({ pid: 1, name: 'bun.exe', commandLine: 'C:\\Kiro-Cli\\bun.exe C:\\Kiro-Cli\\tui.js' }),
    ).toBe(true);
    expect(isKiroProcess({ pid: 1, name: 'node', commandLine: 'node ./server.js' })).toBe(false);
    expect(isKiroProcess({ pid: 1, name: 'bun', commandLine: 'bun run tui.js' })).toBe(true);
  });
});

describe('Kiro identity', () => {
  it('keys the account on email, then the profile ARN, and never on the provider alone', () => {
    const token = parseKiroToken(JSON.stringify({ profile_arn: 'arn:Fake', provider: 'google' }));
    expect(tokenIdentity(token, { email: 'Alice@Example.com', accountType: 'Pro' })).toMatchObject({
      accountKey: 'kiro:email:alice@example.com',
      email: 'Alice@Example.com',
      plan: 'Pro',
    });
    expect(tokenIdentity(token, { provider: 'Google' }).accountKey).toBe('kiro:arn:arn:fake');
    // Two social logins from the same IdP would share a provider-only key and overwrite each other.
    expect(tokenIdentity(parseKiroToken('{}'), { provider: 'Google' }).accountKey).toBeUndefined();
  });

  it('folds camelCase and key/value array rows into the same fields', () => {
    const camel = parseKiroToken(
      JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1893456000, expiresIn: 3600, profileArn: 'arn:fake', provider: 'google' }),
    );
    expect(camel).toMatchObject({ access_token: 'at', refresh_token: 'rt', expires_at: 1893456000, profile_arn: 'arn:fake', provider: 'google' });
    const pairs = parseKiroToken(JSON.stringify([{ key: 'refreshToken', value: 'rt' }, { key: 'accessToken', value: 'at' }]));
    expect(pairs).toMatchObject({ access_token: 'at', refresh_token: 'rt' });
    expect(tokenIdentity(camel, null).accountKey).toBe('kiro:arn:arn:fake');
  });

  it('parses expiry as seconds, milliseconds, or a date string', () => {
    const seconds = tokenIdentity(parseKiroToken(JSON.stringify({ expires_at: '1893456000' })), null);
    const millis = tokenIdentity(parseKiroToken(JSON.stringify({ expires_at: 1893456000000 })), null);
    expect(seconds.tokenExpiresAt).toBe(1893456000000);
    expect(millis.tokenExpiresAt).toBe(1893456000000);
    expect(tokenIdentity(parseKiroToken(JSON.stringify({ expires_at: '2030-01-01T00:00:00Z' })), null).tokenExpiresAt).toBe(
      Date.parse('2030-01-01T00:00:00Z'),
    );
  });

  it('tolerates a token row that is not JSON', () => {
    expect(parseKiroToken('not json')).toEqual({});
    expect(parseKiroToken('[1,2]')).toEqual({});
    expect(parseKiroToken(null)).toEqual({});
  });
});

describe('Kiro credential store', () => {
  it('reads, writes and clears only the login rows', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const snap = (await ctx.provider.readLive())!;
    expect(JSON.parse(Buffer.from(snap.token, 'base64').toString('utf8')).access_token).toContain('alice');
    expect(snap.profile).toBeTruthy();
    expect(ctx.provider.hasLogin(snap)).toBe(true);
    expect(ctx.provider.identity(snap)).toMatchObject({ email: 'alice@example.com' });

    await ctx.provider.clearLive();
    expect(fake.token).toBeNull();
    expect(fake.profile).toBeNull();

    await ctx.provider.writeLive(snap);
    expect(fake.currentTag()).toBe('alice');
  });

  it('fingerprints the token, not the account', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const a = (await ctx.provider.readLive())!;
    fake.rotate('alice', 7);
    const b = (await ctx.provider.readLive())!;
    expect(ctx.provider.fingerprint(a)).not.toBe(ctx.provider.fingerprint(b));
    expect(ctx.provider.fingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.provider.fingerprint(a)).not.toContain('alice');
    expect(ctx.provider.identity(a).accountKey).toBe(ctx.provider.identity(b).accountKey);
  });

  it('reports no login for an empty store and survives a corrupt token', async () => {
    const { fake, ctx } = await setup();
    expect(await ctx.provider.readLive()).toBeNull();
    expect(ctx.provider.hasLogin({ v: 1, token: 'not base64!!' })).toBe(false);
    expect(ctx.provider.identity({ v: 1, token: 'not base64!!' })).toEqual({});
    expect(ctx.provider.identity({ v: 1, token: 'not base64!!', whoami: { email: 'x@example.com' } }).email).toBe(
      'x@example.com',
    );
    expect(fake.loginCalls).toBe(0);
  });

  it('rejects a snapshot in an unsupported format', async () => {
    const { ctx } = await setup();
    await expect(ctx.provider.writeLive({ v: 2, token: 'AAAA'} as unknown as KiroSnapshot)).rejects.toMatchObject({
      code: 'E_FORMAT',
    });
  });
});

describe('Kiro verification and preflight', () => {
  it('verifies the account kiro-cli reports', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    expect(await ctx.provider.verifyLive({ email: 'alice@example.com' })).toMatchObject({ ok: true });
    const wrong = await ctx.provider.verifyLive({ email: 'bob@example.com' });
    expect(wrong).toMatchObject({ ok: false });
    expect(wrong.detail).toContain('bob@example.com');
  });

  it('reports a missing or unreadable login instead of pretending', async () => {
    const { fake, ctx } = await setup();
    expect(await ctx.provider.verifyLive()).toMatchObject({ ok: false, detail: expect.stringContaining('not logged in') });
    fake.loginAs('alice');
    fake.whoAmiError = 'kiro-cli whoami exited with code 1';
    expect(await ctx.provider.verifyLive()).toMatchObject({ ok: false });
  });

  it('still verifies a saved account when whoami can no longer reach the IdP', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const saved = ctx.provider.identity((await ctx.provider.readLive())!);
    expect(saved.accountKey).toBe('kiro:email:alice@example.com');

    // The token row still identifies alice through its profile ARN.
    fake.whoAmi = { accountType: 'Social', provider: 'Google', email: null };
    expect(await ctx.provider.verifyLive(saved)).toMatchObject({ ok: true });
  });

  it('compares profile ARNs when neither side has an email', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    fake.whoAmi = { accountType: 'Social', provider: 'Google', email: null };
    const alice = ctx.provider.identity((await ctx.provider.readLive())!);
    expect(alice.accountKey).toBe('kiro:arn:arn:aws:codewhisperer:us-east-1:111111111111:profile/alice');

    fake.loginAs('bob');
    fake.whoAmi = { accountType: 'Social', provider: 'Google', email: null };
    const res = await ctx.provider.verifyLive(alice);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('profile/bob');
  });

  it('says so when whoami cannot name the account', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    fake.whoAmi = { accountType: 'Social', provider: 'Google', email: null };
    const res = await ctx.provider.verifyLive();
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('did not name it');
  });

  it('skips verification when kiro-cli is not installed', async () => {
    const { fake } = await setup();
    const missing = fake.provider({ PATH: '' });
    fs.rmSync(fake.bin);
    expect(await missing.verifyLive()).toMatchObject({ ok: true, skipped: true });
  });

  it('refuses to operate while KIRO_API_KEY overrides the login', async () => {
    const { fake } = await setup();
    const provider = fake.provider({ PATH: process.env.PATH ?? '', KIRO_API_KEY: 'kt-abc' });
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'E_ENV_OVERRIDE' });
    const blank = fake.provider({ PATH: process.env.PATH ?? '', KIRO_API_KEY: '   ' });
    await expect(blank.preflight()).resolves.toBeUndefined();
  });

  it('does not accept Claude-only login flags', async () => {
    const { fake, ctx } = await setup();
    await expect(ctx.provider.login({ email: 'alice@example.com' })).rejects.toMatchObject({ code: 'E_ARGS' });
    expect(fake.loginCalls).toBe(0);
  });

  it('exposes capabilities that match the CLI', () => {
    expect(getProvider('kiro').capabilities).toEqual({
      login: { email: false, sso: false, console: false, host: false },
      automatedLogin: true,
      manualLogin: true,
      usage: false,
      portableExport: true,
    });
  });
});

describe('Kiro switching', () => {
  it('saves the current login, switches accounts, and restores rotated tokens', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    const alice = await addFromLive(ctx, 'alice');
    fake.loginAs('bob');
    await addFromLive(ctx, 'bob');

    const res = await switchTo(ctx, requireProfile(vault.manifest, 'kiro', 'alice'));
    expect(res.alreadyActive).toBe(false);
    expect(fake.currentTag()).toBe('alice');
    expect(vault.manifest.active['kiro']).toBe(alice.id);

    fake.rotate('alice', 7); // kiro-cli refreshed the token while alice was active
    await switchTo(ctx, requireProfile(vault.manifest, 'kiro', 'bob'));
    expect(fake.currentTag()).toBe('bob');
    await switchTo(ctx, requireProfile(vault.manifest, 'kiro', 'alice'));
    expect(JSON.parse(fake.token as string).access_token).toBe('kiro-at-alice-7');
  });

  it('logs in to another account via kiro-cli and saves it', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    await addFromLive(ctx, 'alice');
    fake.nextLogin = 'bob';
    const res = await addViaLogin(ctx, 'bob');
    expect(res.profile.email).toBe('bob@example.com');
    expect(fake.currentTag()).toBe('bob');
    expect(fake.loginCalls).toBe(1);
    expect(vault.manifest.profiles.map((p) => p.name).sort()).toEqual(['alice', 'bob']);
  });

  it('locks into the vault and records the account that was active', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    const alice = await addFromLive(ctx, 'alice');
    fake.rotate('alice', 9);
    const cap = await lockLive(ctx);
    expect(cap.kind).toBe('updated');
    expect(fake.token).toBeNull();
    expect(vault.manifest.active['kiro']).toBeNull();
    expect(vault.manifest.lastActive['kiro']).toBe(alice.id);

    await switchTo(ctx, alice);
    expect(fake.currentTag()).toBe('alice');
  });

  it('refuses to switch while kiro-cli is running unless forced', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    await addFromLive(ctx, 'alice');
    fake.loginAs('bob');
    await addFromLive(ctx, 'bob');
    fake.running = [{ pid: 42, name: 'kiro-cli.exe' }];
    const alice = requireProfile(vault.manifest, 'kiro', 'alice');
    await expect(switchTo(ctx, alice)).rejects.toMatchObject({ code: 'E_RUNNING' });
    expect(fake.currentTag()).toBe('bob');
    await switchTo(ctx, alice, { force: true });
    expect(fake.currentTag()).toBe('alice');
  });
});

describe('Kiro import validation', () => {
  it('accepts a well-formed snapshot on a machine that has run kiro-cli', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const snap = (await ctx.provider.readLive())!;
    expect(await ctx.provider.validateSnapshot(snap)).toEqual({ ok: true });
  });

  it('rejects a token row without credentials', async () => {
    const { ctx } = await setup();
    const token = Buffer.from(JSON.stringify({ provider: 'google' }), 'utf8').toString('base64');
    expect(await ctx.provider.validateSnapshot({ v: 1, token })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('access_token'),
    });
  });

  it('rejects a profile row that is not a JSON object', async () => {
    const { ctx } = await setup();
    const token = Buffer.from(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), 'utf8').toString('base64');
    const profile = Buffer.from('[1,2]', 'utf8').toString('base64');
    expect(await ctx.provider.validateSnapshot({ v: 1, token, profile })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a JSON object'),
    });
  });

  it('rejects a target machine where Kiro has never stored a login', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const snap = (await ctx.provider.readLive())!;
    const empty = new FakeKiro();
    empty.storeExists = false;
    expect(await empty.provider().validateSnapshot(snap)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no data store'),
    });
  });
});

describe('Kiro export / import', () => {
  it('round-trips a profile through a separately encrypted file', async () => {
    const source = await setup();
    source.fake.loginAs('alice');
    const meta = await addFromLive(source.ctx, 'alice');
    const text = await exportProfiles(source.vault, [meta], 'export passphrase 1');

    const target = await setup();
    const res = await importProfiles(target.vault, text, 'export passphrase 1', {
      validateSnapshot: (m, snapshot) => target.ctx.provider.validateSnapshot(snapshot as KiroSnapshot),
    });
    expect(res.imported.map((p) => p.name)).toEqual(['alice']);
    await switchTo(target.ctx, res.imported[0]!);
    expect(target.fake.currentTag()).toBe('alice');
  });
});

describe('Kiro doctor and registry', () => {
  it('describes the store, the login and the overrides', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const checks = await ctx.provider.doctor();
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('Kiro CLI')).toMatchObject({ status: 'ok' });
    expect(byName.get('Credential store')?.detail).toContain('data.sqlite3');
    expect(byName.get('Live login')).toMatchObject({ status: 'ok', detail: expect.stringContaining('alice@example.com') });
    expect(byName.get('Usage')?.status).toBe('info');
    expect(JSON.stringify(checks)).not.toContain('kiro-at-alice');

    const override = new FakeKiro().provider({ PATH: process.env.PATH ?? '', KIRO_API_KEY: 'kt-abc' });
    const overridden = new Map((await override.doctor()).map((c) => [c.name, c]));
    expect(overridden.get('KIRO_API_KEY')).toMatchObject({ status: 'warn' });
  });

  it('flags a machine where Kiro has never logged in', async () => {
    const fake = new FakeKiro();
    fake.storeExists = false;
    const checks = await fake.provider().doctor();
    const store = checks.find((c) => c.name === 'Credential store');
    expect(store?.status).toBe('warn');
    expect(store?.detail).toContain('run `kiro-cli login`');
  });

  it('registers kiro and accepts the kiro-cli alias', () => {
    expect(getProvider('kiro').id).toBe('kiro');
    expect(getProvider('Kiro-CLI').id).toBe('kiro');
    expect(getProvider('kiro').describeStore().kind).toBe('sqlite');
  });
});

let sqlite: typeof import('node:sqlite') | null = null;
try {
  const mod = await import('node:sqlite');
  if (typeof mod.DatabaseSync === 'function') sqlite = mod;
} catch {
  sqlite = null;
}

describe.runIf(Boolean(sqlite))('Kiro SQLite store (node:sqlite)', () => {
  const sql = sqlite!;

  function freshFile(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-db-')), 'data.sqlite3');
  }

  function realStore(file: string): KiroStore {
    return new KiroStore({
      platform: process.platform,
      home: path.dirname(file),
      dataDir: path.dirname(file),
      dbFile: file,
      settingsDir: path.join(path.dirname(file), '.kiro'),
    });
  }

  function withTables(file: string): void {
    const db = new sql.DatabaseSync(file);
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)');
    db.close();
  }

  it('round-trips exactly the two rows it owns', async () => {
    const file = freshFile();
    withTables(file);
    const s = realStore(file);
    expect(await s.readToken()).toBeNull();

    await s.writeRows('{"access_token":"a"}', '{"arn":"x"}');
    expect(await s.readToken()).toBe('{"access_token":"a"}');
    expect(await s.readProfile()).toBe('{"arn":"x"}');

    await s.writeRows('{"access_token":"b"}', null);
    expect(await s.readToken()).toBe('{"access_token":"b"}');
    expect(await s.readProfile()).toBeNull();

    await s.clearRows();
    expect(await s.readToken()).toBeNull();
  });

  it('leaves every other row in the database alone', async () => {
    const file = freshFile();
    const seed = new sql.DatabaseSync(file);
    seed.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    seed.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)');
    seed.prepare('insert into state(key, value) values(?, ?)').run('telemetry-cognito-credentials', 'SECRET');
    seed.close();

    await realStore(file).clearRows();

    const check = new sql.DatabaseSync(file, { readOnly: true });
    const kept = check.prepare('select value from state where key = ?').get('telemetry-cognito-credentials');
    expect((kept as { value: unknown }).value).toBe('SECRET');
    check.close();
  });

  it('rolls the token row back when the profile row cannot be written', async () => {
    const file = freshFile();
    withTables(file);
    const s = realStore(file);
    await s.writeRows('OLD-TOKEN', 'OLD-PROFILE');

    const broken = new sql.DatabaseSync(file);
    broken.exec('drop table state');
    broken.close();

    await expect(s.writeRows('NEW-TOKEN', 'NEW-PROFILE')).rejects.toMatchObject({ code: 'E_KIRO_STORE' });
    expect(await s.readToken()).toBe('OLD-TOKEN');
  });

  it('clears the login table even when Kiro has not created the profile table', async () => {
    const file = freshFile();
    withTables(file);
    const s = realStore(file);
    await s.writeRows('TOKEN', 'PROFILE');

    const broken = new sql.DatabaseSync(file);
    broken.exec('drop table state');
    broken.close();

    await s.clearRows();
    expect(await s.readToken()).toBeNull();
  });

  it('reports a missing store and a store without login tables', async () => {
    const missing = realStore(freshFile());
    expect(missing.exists()).toBe(false);
    expect(await missing.readToken()).toBeNull();
    await expect(missing.writeRows('x', null)).rejects.toMatchObject({ code: 'E_KIRO_STORE' });

    const bare = freshFile();
    new sql.DatabaseSync(bare).close();
    const noTables = realStore(bare);
    expect(noTables.exists()).toBe(true);
    expect(await noTables.readToken()).toBeNull();
    await expect(noTables.writeRows('x', null)).rejects.toMatchObject({ code: 'E_KIRO_STORE' });
    await noTables.clearRows();
  });
});
