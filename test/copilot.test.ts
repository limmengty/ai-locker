import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanCopilotEnv, OVERRIDING_ENV_VARS, resolveCopilotEnv } from '../src/providers/copilot/env.js';
import { isCopilotProcess } from '../src/providers/copilot/process.js';
import { readActiveUser, readRoster, parseCopilotConfig } from '../src/providers/copilot/config.js';
import { getProvider } from '../src/providers/index.js';
import { addFromLive, addViaLogin, lockLive, switchTo } from '../src/core/switchService.js';
import { requireProfile } from '../src/core/profiles.js';
import { exportProfiles, importProfiles } from '../src/core/transfer.js';
import { FakeCopilot, newVault } from './helpers.js';

async function setup() {
  const fake = new FakeCopilot();
  const { vault, paths } = await newVault();
  return { fake, vault, paths, ctx: { vault, provider: fake.provider() } };
}

function profileNames(vault: { manifest: { profiles: { name: string }[] } }): string[] {
  return vault.manifest.profiles.map((p) => p.name).sort();
}

describe('Copilot environment', () => {
  it('defaults to ~/.copilot and a per-platform cache directory', () => {
    const linux = resolveCopilotEnv({}, 'linux', '/home/me');
    expect(linux.configDir).toBe(path.join('/home/me', '.copilot'));
    expect(linux.configFile).toBe(path.join('/home/me', '.copilot', 'config.json'));
    expect(linux.userCacheFile).toBe(path.join('/home/me', '.cache', 'copilot', 'copilot-user-cache.json'));

    const custom = resolveCopilotEnv({ COPILOT_HOME: path.resolve('/tmp/copilot-home') }, 'linux', '/home/me');
    expect(custom.configDir).toBe(path.resolve('/tmp/copilot-home'));

    const win = resolveCopilotEnv(
      { LOCALAPPDATA: path.win32.join('C:', 'Users', 'me', 'AppData', 'Local') },
      'win32',
      path.win32.join('C:', 'Users', 'me'),
    );
    expect(win.configDir).toBe(path.win32.join('C:', 'Users', 'me', '.copilot'));
    expect(win.userCacheFile).toBe(
      path.win32.join('C:', 'Users', 'me', 'AppData', 'Local', 'copilot', 'copilot-user-cache.json'),
    );
  });

  it('strips token overrides and keytar bypass before spawning copilot', () => {
    const env = cleanCopilotEnv({
      PATH: '/bin',
      COPILOT_GITHUB_TOKEN: 'secret',
      GH_TOKEN: 'x',
      GITHUB_TOKEN: 'y',
      GH_ENTERPRISE_TOKEN: 'z',
      COPILOT_DISABLE_KEYTAR: '1',
    });
    expect(env.PATH).toBe('/bin');
    for (const key of OVERRIDING_ENV_VARS) expect(env[key]).toBeUndefined();
    expect(env.COPILOT_DISABLE_KEYTAR).toBeUndefined();
  });
});

describe('Copilot process detection', () => {
  it('recognises the native binaries and the bundled CLI script', () => {
    expect(isCopilotProcess({ pid: 1, name: 'copilot.exe', commandLine: '' })).toBe(true);
    expect(isCopilotProcess({ pid: 1, name: 'copilot-runtime.exe', commandLine: '' })).toBe(true);
    expect(isCopilotProcess({ pid: 1, name: 'copilot', commandLine: '' })).toBe(true);
    expect(
      isCopilotProcess({
        pid: 1,
        name: 'node',
        commandLine: `node C:\\npm\\node_modules\\@github\\copilot\\cli-main.js`,
      }),
    ).toBe(true);
    expect(
      isCopilotProcess({
        pid: 1,
        name: 'node.exe',
        commandLine: `node C:\\Users\\me\\.copilot\\pkg\\win32-x64\\1.0.103\\cli-main.js`,
      }),
    ).toBe(true);
    expect(isCopilotProcess({ pid: 1, name: 'node', commandLine: 'node /x/ai-locker/dist/cli.js use work' })).toBe(false);
  });
});

describe('Copilot credential store', () => {
  it('reads both keyring items and the roster identity', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('octocat');
    const snap = (await ctx.provider.readLive())!;
    expect(snap).toMatchObject({ host: 'https://github.com', login: 'octocat', kind: 'githubDotCom', plan: 'individual' });
    expect(snap.credentials.map((c) => c.account)).toEqual([
      'https://github.com:octocat',
      'https://github.com:octocat:github',
    ]);
    expect(ctx.provider.hasLogin(snap)).toBe(true);
    expect(ctx.provider.identity(snap)).toEqual({
      accountKey: 'copilot:https://github.com:octocat',
      username: 'octocat',
      plan: 'individual',
    });
  });

  it('returns no login when the roster is empty', async () => {
    const { ctx } = await setup();
    expect(await ctx.provider.readLive()).toBeNull();
  });

  it('fingerprints the tokens, not the account', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('octocat');
    const a = (await ctx.provider.readLive())!;
    const before = ctx.provider.fingerprint(a);
    expect(ctx.provider.fingerprint((await ctx.provider.readLive())!)).toBe(before);
    fake.rotate('octocat', 3);
    const b = (await ctx.provider.readLive())!;
    expect(ctx.provider.fingerprint(b)).not.toBe(before);
    expect(ctx.provider.identity(b).accountKey).toBe(ctx.provider.identity(a).accountKey);
    expect(before).not.toContain('gho_');
  });

  it('clears the active account without disturbing comments or other users', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('alice');
    fake.loginAs('bob');
    await ctx.provider.clearLive();
    expect(fake.currentTag()).toBeNull();
    expect(fake.keyring.items.has('https://github.com:bob.copilot-cli')).toBe(false);
    const config = parseCopilotConfig(fake.configText());
    expect(readActiveUser(config)).toBeNull();
    expect(readRoster(config)).toEqual([{ host: 'https://github.com', login: 'alice', kind: 'githubDotCom' }]);
    expect(fake.configText()).toContain('This file is managed automatically.');
  });

  it('restores both keyring items and the roster on switch', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    const alice = await addFromLive(ctx, 'alice');
    fake.loginAs('bob');
    await addFromLive(ctx, 'bob');

    await switchTo(ctx, requireProfile(vault.manifest, 'copilot', 'alice'));
    expect(fake.currentTag()).toBe('alice');
    const config = parseCopilotConfig(fake.configText());
    expect(config.lastLoggedInUser).toEqual({ host: 'https://github.com', login: 'alice' });
    expect(readRoster(config).map((u) => u.login)).toEqual(['alice', 'bob']);
    expect(fake.configText()).toContain('This file is managed automatically.');
    expect(alice.id).toBe(vault.manifest.active['copilot']);
  });

  it('saves rotated tokens and restores them after switching away', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    const alice = await addFromLive(ctx, 'alice');
    fake.loginAs('bob');
    await addFromLive(ctx, 'bob');

    fake.loginAs('alice');
    fake.rotate('alice', 7);
    await switchTo(ctx, requireProfile(vault.manifest, 'copilot', 'bob'));
    await switchTo(ctx, requireProfile(vault.manifest, 'copilot', 'alice'));
    const token = fake.keyring.items.get('https://github.com:alice.copilot-cli')!.secret.toString('utf16le');
    expect(token).toContain('revision_7');
    expect(alice.id).toBe(vault.manifest.active['copilot']);
  });

  it('locks the login into the vault and restores it later', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    const alice = await addFromLive(ctx, 'alice');
    fake.rotate('alice', 9);
    const cap = await lockLive(ctx);
    expect(cap.kind).toBe('updated');
    expect(fake.currentTag()).toBeNull();
    expect(vault.manifest.active['copilot']).toBeNull();
    expect(vault.manifest.lastActive['copilot']).toBe(alice.id);

    await switchTo(ctx, alice);
    expect(fake.keyring.items.get('https://github.com:alice.copilot-cli')!.secret.toString('utf16le')).toContain(
      'revision_9',
    );
  });
});

describe('Copilot login and verification', () => {
  it('logs in to another account through the CLI and saves it', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    await addFromLive(ctx, 'alice');
    fake.nextLogin = 'bob';
    const res = await addViaLogin(ctx, 'bob');
    expect(res.profile.username).toBe('bob');
    expect(fake.currentTag()).toBe('bob');
    expect(fake.loginCalls).toBe(1);
    expect(profileNames(vault)).toEqual(['alice', 'bob']);
  });

  it('verifies the account through GitHub and reports mismatches', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('octocat');
    expect(await ctx.provider.verifyLive({ username: 'octocat' })).toMatchObject({ ok: true, username: 'octocat' });
    expect(await ctx.provider.verifyLive({ username: 'someone-else' })).toMatchObject({ ok: false });

    fake.verifyStatus = 401;
    expect(await ctx.provider.verifyLive()).toMatchObject({ ok: false, detail: expect.stringContaining('401') });
  });

  it('skips verification when GitHub is unreachable', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('octocat');
    fake.verifyError = 'offline';
    const res = await ctx.provider.verifyLive();
    expect(res).toMatchObject({ ok: true, skipped: true });
    expect(res.detail).toContain('offline');
  });

  it('refuses to operate while Copilot is running unless forced', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('alice');
    await addFromLive(ctx, 'alice');
    fake.loginAs('bob');
    await addFromLive(ctx, 'bob');
    fake.running = [{ pid: 42, name: 'copilot.exe' }];
    const alice = requireProfile(vault.manifest, 'copilot', 'alice');
    await expect(switchTo(ctx, alice)).rejects.toMatchObject({ code: 'E_RUNNING' });
    await switchTo(ctx, alice, { force: true });
    expect(fake.currentTag()).toBe('alice');
  });

  it('rejects --email and non-https hosts', async () => {
    const { fake, ctx } = await setup();
    await expect(ctx.provider.login({ email: 'a@b.c' })).rejects.toMatchObject({ code: 'E_ARGS' });
    await expect(ctx.provider.login({ host: 'http://github.com' })).rejects.toMatchObject({ code: 'E_ARGS' });
    expect(fake.loginCalls).toBe(0);
  });
});

describe('Copilot preflight', () => {
  it('refuses environment tokens and keyring bypasses', async () => {
    const { fake } = await setup();
    const pathOnly = { PATH: process.env.PATH ?? '' };
    for (const key of OVERRIDING_ENV_VARS) {
      const p = fake.provider({ ...pathOnly, [key]: 'value' });
      await expect(p.preflight()).rejects.toMatchObject({ code: 'E_ENV_OVERRIDE' });
    }
    const whitelist = fake.provider({ ...pathOnly, GH_TOKEN: '   ' });
    await expect(whitelist.preflight()).resolves.toBeUndefined();
    const disabled = fake.provider({ ...pathOnly, COPILOT_DISABLE_KEYTAR: '1' });
    await expect(disabled.preflight()).rejects.toMatchObject({ code: 'E_COPILOT_KEYTAR' });
  });

  it('refuses plaintext token storage', async () => {
    const { fake } = await setup();
    fs.writeFileSync(fake.settingsFile, '{\n  // insecure\n  "storeTokenPlaintext": true\n}\n');
    await expect(fake.provider().preflight()).rejects.toMatchObject({ code: 'E_COPILOT_PLAINTEXT' });
  });

  it('exposes capabilities that match the CLI', () => {
    const p = getProvider('copilot');
    expect(p.capabilities).toEqual({
      login: { email: false, sso: false, console: false, host: true },
      automatedLogin: true,
      manualLogin: true,
      usage: false,
      portableExport: true,
    });
  });
});

describe('Copilot snapshot validation', () => {
  it('accepts a captured snapshot and refuses another account or chunked entries', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs('octocat');
    const snap = (await ctx.provider.readLive())!;
    expect(await ctx.provider.validateSnapshot(snap)).toEqual({ ok: true });

    expect(
      await ctx.provider.validateSnapshot({
        ...snap,
        credentials: [{ account: 'https://github.com:other', token: snap.credentials[0]!.token }],
      }),
    ).toMatchObject({ ok: false });

    expect(await ctx.provider.validateSnapshot({ ...snap, credentials: [] })).toMatchObject({ ok: false });

    const chunked = Buffer.from('copilot-keychain-chunks-v1:abc').toString('base64');
    expect(
      await ctx.provider.validateSnapshot({ ...snap, credentials: [{ account: 'https://github.com:octocat', token: chunked }] }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('chunked') });
  });
});

describe('Copilot export / import', () => {
  it('moves a profile to another machine', async () => {
    const source = await setup();
    source.fake.loginAs('octocat');
    const meta = await addFromLive(source.ctx, 'octocat');
    const text = await exportProfiles(source.vault, [meta], 'export passphrase 1');

    const target = await setup();
    const res = await importProfiles(target.vault, text, 'export passphrase 1', {
      validateSnapshot: (m, snapshot) => target.ctx.provider.validateSnapshot(snapshot as any),
    });
    expect(res.imported.map((p) => p.name)).toEqual(['octocat']);
    expect(res.imported[0]!.username).toBe('octocat');
    await switchTo(target.ctx, res.imported[0]!);
    expect(target.fake.currentTag()).toBe('octocat');
  });

  it('skips a profile that is already saved', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs('octocat');
    const meta = await addFromLive(ctx, 'octocat');
    const text = await exportProfiles(vault, [meta], 'export passphrase 1');
    const res = await importProfiles(vault, text, 'export passphrase 1');
    expect(res.imported).toHaveLength(0);
    expect(res.skipped).toEqual([{ name: 'octocat', reason: expect.stringContaining('octocat') }]);
  });
});
