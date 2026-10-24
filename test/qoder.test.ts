import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanQoderEnv, OVERRIDING_ENV_VARS, resolveQoderEnv } from '../src/providers/qoder/env.js';
import { isQoderProcess } from '../src/providers/qoder/process.js';
import { statusToIdentity } from '../src/providers/qoder/status.js';
import type { QoderSnapshot } from '../src/providers/qoder/index.js';
import { MAX_QODER_SNAPSHOT_BYTES } from '../src/providers/qoder/store.js';
import { getProvider } from '../src/providers/index.js';
import { addFromLive, addViaLogin, lockLive, switchTo } from '../src/core/switchService.js';
import { requireProfile } from '../src/core/profiles.js';
import { exportProfiles, importProfiles } from '../src/core/transfer.js';
import { FakeQoder, newVault, qoderStatus } from './helpers.js';

async function setup(machineId?: string) {
  const fake = new FakeQoder(machineId);
  const { vault, paths } = await newVault();
  const ctx = { vault, provider: fake.provider() };
  return { fake, vault, paths, ctx };
}

describe('Qoder environment', () => {
  it('defaults to ~/.qoder with auth files underneath', () => {
    const env = resolveQoderEnv({}, 'linux', '/home/me');
    expect(env.configDir).toBe(path.join('/home/me', '.qoder'));
    expect(env.userFile).toBe(path.join('/home/me', '.qoder', '.auth', 'user'));
    expect(env.machineIdFile).toBe(path.join('/home/me', '.qoder', '.auth', 'machine_id'));
  });

  it('honours QODER_CONFIG_DIR (full path) and QODER_CONFIG_DIR_NAME (name under home)', () => {
    const full = path.resolve('/tmp/qoder-work');
    const dir = resolveQoderEnv({ QODER_CONFIG_DIR: full }, 'linux', '/home/me');
    expect(dir.configDir).toBe(full);

    const named = resolveQoderEnv({ QODER_CONFIG_DIR_NAME: '.qoder-work' }, 'linux', '/home/me');
    expect(named.configDir).toBe(path.join('/home/me', '.qoder-work'));

    const both = resolveQoderEnv({ QODER_CONFIG_DIR: path.resolve('/a'), QODER_CONFIG_DIR_NAME: 'b' }, 'linux', '/home/me');
    expect(both.configDir).toBe(path.resolve('/a'));
  });

  it('rejects a directory name that is really a path', () => {
    expect(() => resolveQoderEnv({ QODER_CONFIG_DIR_NAME: '../escape' }, 'linux', '/home/me')).toThrow(
      expect.objectContaining({ code: 'E_ENV' }),
    );
  });

  it('strips credential overrides before spawning qodercli', () => {
    const env = cleanQoderEnv({ PATH: '/bin', QODER_PERSONAL_ACCESS_TOKEN: 'secret', QODER_JOB_TOKEN: 'x' });
    expect(env.PATH).toBe('/bin');
    for (const key of OVERRIDING_ENV_VARS) expect(env[key]).toBeUndefined();
  });
});

describe('Qoder process detection', () => {
  it('recognises the native binary and the script form', () => {
    expect(isQoderProcess({ pid: 1, name: 'qodercli.exe', commandLine: '' })).toBe(true);
    expect(isQoderProcess({ pid: 1, name: '/usr/local/bin/qodercli', commandLine: '' })).toBe(true);
    expect(isQoderProcess({ pid: 1, name: 'node', commandLine: 'node C:\\npm\\qodercli.js status' })).toBe(true);
    expect(isQoderProcess({ pid: 1, name: 'node', commandLine: 'node ./bun/qodercli' })).toBe(true);
    expect(isQoderProcess({ pid: 1, name: 'node', commandLine: 'node /x/ai-locker/dist/cli.js --provider qoder' })).toBe(false);
    expect(isQoderProcess({ pid: 1, name: 'node', commandLine: 'node /x/index.js qodercli.js' })).toBe(false);
  });
});

describe('Qoder identity', () => {
  it('prefers the avatar user UUID, then email', () => {
    expect(statusToIdentity(qoderStatus('alice'))).toMatchObject({
      email: 'alice@example.com',
      plan: 'pro',
    });
    expect(statusToIdentity(qoderStatus('alice')).accountKey).toMatch(/^qoder:uid:/);
    expect(statusToIdentity({ logged_in: true, email: 'bob@example.com' })).toEqual({
      accountKey: 'qoder:email:bob@example.com',
      email: 'bob@example.com',
      organization: undefined,
      plan: undefined,
    });
    expect(statusToIdentity({ logged_in: false, email: 'x@example.com' })).toEqual({});
  });

  it('uses the principal for service accounts', () => {
    const id = statusToIdentity({
      logged_in: true,
      email: 'svc@example.com',
      account_type: 'service_account',
      org_id: 'org-1',
      principal_id: 'svc-2',
    });
    expect(id.accountKey).toBe('qoder:sa:org-1:svc-2');
    expect(id.organization).toBe('org-1');
  });
});

describe('Qoder credential store', () => {
  it('reads, writes and clears only the login blob', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const snap = (await ctx.provider.readLive())!;
    expect(Buffer.from(snap.user, 'base64').toString()).toContain('alice');
    expect(snap.machineIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(snap.machineIdHash).not.toContain(fake.machineIdFile);
    expect(ctx.provider.identity(snap)).toMatchObject({ email: 'alice@example.com' });
    expect(ctx.provider.hasLogin(snap)).toBe(true);

    await ctx.provider.clearLive();
    expect(fake.currentTag()).toBeNull();
    expect(fs.existsSync(fake.machineIdFile)).toBe(true);

    await ctx.provider.writeLive(snap);
    expect(fake.currentTag()).toBe('alice');
  });

  it('treats a stored credential that reports logged_out as no login', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    fake.statusOverride = { logged_in: false, auth_error_reason: 'CREDENTIAL_EXPIRED' };
    const snap = (await ctx.provider.readLive())!;
    expect(ctx.provider.hasLogin(snap)).toBe(false);
    expect(ctx.provider.identity(snap)).toEqual({});
  });

  it('fingerprints the blob, not the account', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const a = (await ctx.provider.readLive())!;
    fake.rotate('alice', 2);
    const b = (await ctx.provider.readLive())!;
    expect(ctx.provider.fingerprint(a)).not.toBe(ctx.provider.fingerprint(b));
    expect(ctx.provider.identity(a).accountKey).toBe(ctx.provider.identity(b).accountKey);
    expect(ctx.provider.fingerprint(a)).not.toContain('alice');
  });

  it('rejects oversized files instead of loading them', async () => {
    const { fake, ctx } = await setup();
    fs.writeFileSync(fake.userFile, Buffer.alloc(MAX_QODER_SNAPSHOT_BYTES + 1, 1));
    await expect(ctx.provider.readLive()).rejects.toMatchObject({ code: 'E_STORE' });
  });
});

describe('Qoder machine binding', () => {
  it('refuses a snapshot captured on a different machine', async () => {
    const a = await setup('11111111-2222-4333-8444-555555555555');
    a.fake.loginAs('alice');
    const snap = (await a.ctx.provider.readLive())!;

    const b = await setup('99999999-8888-4777-8666-555555555555');
    await expect(b.ctx.provider.writeLive(snap)).rejects.toMatchObject({ code: 'E_QODER_MACHINE' });
    expect(await b.ctx.provider.validateSnapshot(snap)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('another machine'),
    });
  });

  it('refuses to restore when this machine has no machine_id', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    const snap = (await ctx.provider.readLive())!;
    fs.rmSync(fake.machineIdFile);
    await expect(ctx.provider.writeLive(snap)).rejects.toMatchObject({ code: 'E_QODER_MACHINE' });
    expect(await ctx.provider.validateSnapshot(snap)).toMatchObject({ ok: false });
  });

  it('accepts a snapshot with no recorded machine hash', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('bob');
    const snap = (await ctx.provider.readLive())!;
    await expect(ctx.provider.validateSnapshot({ v: 1, user: snap.user })).resolves.toEqual({ ok: true });
  });
});

describe('Qoder verification and preflight', () => {
  it('verifies the account reported by qodercli status', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    expect(await ctx.provider.verifyLive({ email: 'alice@example.com' })).toMatchObject({ ok: true });
    const wrong = await ctx.provider.verifyLive({ email: 'bob@example.com' });
    expect(wrong).toMatchObject({ ok: false });
    expect(wrong.detail).toContain('bob@example.com');
  });

  it('rejects an environment-provided credential and status failures', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    fake.statusOverride = qoderStatus('alice', { auth_source: 'external' });
    expect(await ctx.provider.verifyLive()).toMatchObject({ ok: false, detail: expect.stringContaining('environment credential') });

    fake.statusOverride = null;
    fake.statusError = 'qodercli status exited with code 1';
    expect(await ctx.provider.verifyLive()).toMatchObject({ ok: false });
  });

  it('refuses to operate while a personal access token overrides the login', async () => {
    const { fake } = await setup();
    const provider = fake.provider({ PATH: process.env.PATH ?? '', QODER_PERSONAL_ACCESS_TOKEN: 'pat-value' });
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'E_ENV_OVERRIDE' });
    const whitespace = fake.provider({ PATH: process.env.PATH ?? '', QODER_PERSONAL_ACCESS_TOKEN: '   ' });
    await expect(whitespace.preflight()).resolves.toBeUndefined();
  });

  it('does not accept Claude-only login flags', async () => {
    const { fake, ctx } = await setup();
    await expect(ctx.provider.login({ email: 'alice@example.com' })).rejects.toMatchObject({ code: 'E_ARGS' });
    expect(fake.loginCalls).toBe(0);
  });

  it('exposes capabilities that match the CLI', () => {
    const p = getProvider('qoder');
    expect(p.capabilities).toEqual({
      login: { email: false, sso: false, console: false, host: false },
      automatedLogin: true,
      manualLogin: true,
      usage: false,
      portableExport: false,
    });
    expect(() => getProvider('nope')).toThrow(expect.objectContaining({ code: 'E_ARGS' }));
  });
});

describe('Qoder switching', () => {
  it('saves the current login, switches accounts, and restores rotated tokens', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    const alice = await addFromLive(ctx, 'alice');
    fake.loginAs('bob');
    await addFromLive(ctx, 'bob');

    const res = await switchTo(ctx, requireProfile(vault.manifest, 'qoder', 'alice'));
    expect(res.alreadyActive).toBe(false);
    expect(fake.currentTag()).toBe('alice');
    expect(vault.manifest.active['qoder']).toBe(alice.id);

    fake.rotate('alice', 7); // qodercli refreshed while alice was active
    await switchTo(ctx, requireProfile(vault.manifest, 'qoder', 'bob'));
    expect(fake.currentTag()).toBe('bob');
    await switchTo(ctx, requireProfile(vault.manifest, 'qoder', 'alice'));
    expect(JSON.parse(fs.readFileSync(fake.userFile, 'utf8')).revision).toBe(7);
  });

  it('logs in to another account via qodercli and saves it', async () => {
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
    expect(fake.currentTag()).toBeNull();
    expect(vault.manifest.active['qoder']).toBeNull();
    expect(vault.manifest.lastActive['qoder']).toBe(alice.id);

    await switchTo(ctx, alice);
    expect(JSON.parse(fs.readFileSync(fake.userFile, 'utf8')).revision).toBe(9);
  });

  it('refuses to switch while qodercli is running unless forced', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    await addFromLive(ctx, 'alice');
    fake.loginAs('bob');
    await addFromLive(ctx, 'bob');
    fake.running = [{ pid: 42, name: 'qodercli.exe' }];
    const alice = requireProfile(vault.manifest, 'qoder', 'alice');
    await expect(switchTo(ctx, alice)).rejects.toMatchObject({ code: 'E_RUNNING' });
    expect(fake.currentTag()).toBe('bob');
    await switchTo(ctx, alice, { force: true });
    expect(fake.currentTag()).toBe('alice');
  });
});

describe('Qoder export / import', () => {
  it('imports on the same machine', async () => {
    const source = await setup('11111111-2222-4333-8444-555555555555');
    source.fake.loginAs('alice');
    const meta = await addFromLive(source.ctx, 'alice');
    const text = await exportProfiles(source.vault, [meta], 'export passphrase 1');

    const target = await setup('11111111-2222-4333-8444-555555555555');
    const res = await importProfiles(target.vault, text, 'export passphrase 1', {
      validateSnapshot: (m, snapshot) => target.ctx.provider.validateSnapshot(snapshot as QoderSnapshot),
    });
    expect(res.imported.map((p) => p.name)).toEqual(['alice']);
    await switchTo(target.ctx, res.imported[0]!);
    expect(target.fake.currentTag()).toBe('alice');
  });

  it('skips a profile captured on another machine', async () => {
    const source = await setup('11111111-2222-4333-8444-555555555555');
    source.fake.loginAs('alice');
    const meta = await addFromLive(source.ctx, 'alice');
    const text = await exportProfiles(source.vault, [meta], 'export passphrase 1');

    const target = await setup('99999999-8888-4777-8666-555555555555');
    const res = await importProfiles(target.vault, text, 'export passphrase 1', {
      validateSnapshot: (m, snapshot) => target.ctx.provider.validateSnapshot(snapshot as QoderSnapshot),
    });
    expect(res.imported).toHaveLength(0);
    expect(res.skipped).toEqual([{ name: 'alice', reason: expect.stringContaining('another machine') }]);
    expect(target.vault.manifest.profiles).toHaveLength(0);
  });
});
