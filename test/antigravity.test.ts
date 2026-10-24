import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanAgyEnv, resolveAgyEnv } from '../src/providers/antigravity/env.js';
import { isAgyProcess } from '../src/providers/antigravity/process.js';
import { parseAgyCredential } from '../src/providers/antigravity/credential.js';
import { AgyProvider, type AgySnapshot } from '../src/providers/antigravity/index.js';
import { getProvider } from '../src/providers/index.js';
import { addFromLive, addViaLogin, lockLive, switchTo } from '../src/core/switchService.js';
import { requireProfile } from '../src/core/profiles.js';
import { exportProfiles, importProfiles } from '../src/core/transfer.js';
import type { KeyringBackend } from '../src/util/keyring.js';
import { FakeAgy, newVault } from './helpers.js';

const EMAIL = 'user@example.com';

async function setup() {
  const fake = new FakeAgy();
  const { vault } = await newVault();
  return { fake, vault, ctx: { vault, provider: fake.provider() } };
}

describe('Antigravity environment', () => {
  it('keeps all state under ~/.gemini', () => {
    const home = path.join('/home', 'me');
    const env = resolveAgyEnv('linux', home);
    expect(env.geminiDir).toBe(path.join(home, '.gemini'));
    expect(env.stateDir).toBe(path.join(home, '.gemini', 'antigravity-cli'));
    expect(env.configDir).toBe(path.join(home, '.gemini', 'config'));
  });

  it('strips credential and gateway overrides before spawning agy', () => {
    const env = cleanAgyEnv({
      PATH: '/bin',
      AGY_ADC_AUTH: '1',
      GEMINI_API_KEY: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
      ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: '{}',
      AGY_ACCOUNT: 'work',
      AGY_LLM_GATEWAY_URL: 'https://gateway',
      SSH_TTY: '/dev/pts/1',
    });
    expect(env.PATH).toBe('/bin');
    for (const key of [
      'AGY_ADC_AUTH',
      'GEMINI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'ANTIGRAVITY_OAUTH_CREDENTIALS_JSON',
      'AGY_ACCOUNT',
      'AGY_LLM_GATEWAY_URL',
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.SSH_TTY).toBe('/dev/pts/1');
  });
});

describe('Antigravity process detection', () => {
  it('recognises agy but not the Antigravity IDE', () => {
    expect(isAgyProcess({ pid: 1, name: 'agy.exe', commandLine: '' })).toBe(true);
    expect(isAgyProcess({ pid: 1, name: 'agy', commandLine: '' })).toBe(true);
    expect(
      isAgyProcess({ pid: 1, name: 'agy.exe', commandLine: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe' }),
    ).toBe(true);
    expect(isAgyProcess({ pid: 1, name: 'Antigravity.exe', commandLine: 'C:\\Antigravity\\Antigravity.exe' })).toBe(
      false,
    );
    expect(isAgyProcess({ pid: 1, name: 'node', commandLine: 'node /x/ai-locker/dist/cli.js use work' })).toBe(false);
  });
});

describe('Antigravity credential parsing', () => {
  it('reads the OAuth JSON from the keyring', () => {
    const credential = parseAgyCredential(
      Buffer.from(
        JSON.stringify({
          auth_method: 'oauth',
          id_token_email: EMAIL,
          token: { access_token: 'ya29.x', refresh_token: '1//x', expiry: 1_700_000_000 },
        }),
      ),
    );
    expect(credential).toMatchObject({
      email: EMAIL,
      authMethod: 'oauth',
      accessToken: 'ya29.x',
      refreshToken: '1//x',
      expiresAt: 1_700_000_000_000,
    });
  });

  it('accepts top-level tokens and ISO expiries', () => {
    const credential = parseAgyCredential(
      Buffer.from(JSON.stringify({ access_token: 'ya29.y', email: EMAIL, expiry: '2030-01-01T00:00:00Z' })),
    );
    expect(credential.accessToken).toBe('ya29.y');
    expect(credential.email).toBe(EMAIL);
    expect(credential.expiresAt).toBe(Date.parse('2030-01-01T00:00:00Z'));
  });

  it('refuses blobs without a token or with invalid JSON', () => {
    expect(() => parseAgyCredential(Buffer.from('{}'))).toThrow(/access or refresh token/);
    expect(() => parseAgyCredential(Buffer.from('not json'))).toThrow(/not valid JSON/);
    expect(() => parseAgyCredential(Buffer.alloc(0))).toThrow(/empty/);
  });
});

describe('Antigravity credential store', () => {
  it('captures the keyring login and its identity', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs(EMAIL);
    const snap = (await ctx.provider.readLive())!;
    expect(ctx.provider.hasLogin(snap)).toBe(true);
    const identity = ctx.provider.identity(snap);
    expect(identity.email).toBe(EMAIL);
    expect(identity.accountKey).toBe(`agy:${EMAIL}`);
    expect(identity.tokenExpiresAt).toBeGreaterThan(Date.now());
    expect(fake.currentEmail()).toBe(EMAIL);
  });

  it('returns no login when the keyring has no agy item', async () => {
    const { ctx } = await setup();
    expect(await ctx.provider.readLive()).toBeNull();
  });

  it('fingerprints the token blob without exposing it', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs(EMAIL);
    const before = ctx.provider.fingerprint((await ctx.provider.readLive())!);
    expect(ctx.provider.fingerprint((await ctx.provider.readLive())!)).toBe(before);
    fake.rotate(EMAIL, 2);
    const after = ctx.provider.fingerprint((await ctx.provider.readLive())!);
    expect(after).not.toBe(before);
    expect(before).not.toContain('ya29');
  });

  it('clears the keyring item and restores it on switch', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs(EMAIL);
    const work = await addFromLive(ctx, 'work');
    await ctx.provider.clearLive();
    expect(fake.currentEmail()).toBeNull();

    await switchTo(ctx, work);
    expect(fake.currentEmail()).toBe(EMAIL);
    expect(vault.manifest.active['agy']).toBe(work.id);
  });

  it('restores a rotated token after switching away and back', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs(EMAIL);
    await addFromLive(ctx, 'one');
    fake.loginAs('second@example.com');
    await addFromLive(ctx, 'two');
    fake.loginAs(EMAIL);
    fake.rotate(EMAIL, 7);
    await switchTo(ctx, requireProfile(vault.manifest, 'agy', 'two'));
    await switchTo(ctx, requireProfile(vault.manifest, 'agy', 'one'));
    expect(fake.credentialText()).toContain('revision_7');
  });

  it('locks the login into the vault and restores it later', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs(EMAIL);
    const work = await addFromLive(ctx, 'work');
    fake.rotate(EMAIL, 9);
    const capture = await lockLive(ctx);
    expect(capture.kind).toBe('updated');
    expect(fake.currentEmail()).toBeNull();
    expect(vault.manifest.active['agy']).toBeNull();

    await switchTo(ctx, work);
    expect(fake.credentialText()).toContain('revision_9');
  });
});

describe('Antigravity login and verification', () => {
  it('saves a manual TUI login', async () => {
    const { fake, vault, ctx } = await setup();
    const res = await addViaLogin(ctx, 'work', {
      manual: async () => {
        fake.loginAs(EMAIL);
      },
    });
    expect(res.profile.email).toBe(EMAIL);
    expect(fake.modelsCalls).toBe(1);
    expect(vault.manifest.active['agy']).toBe(res.profile.id);
  });

  it('launches the TUI and saves the login it produces', async () => {
    const fake = new FakeAgy();
    const { vault } = await newVault();
    fake.loginImpl = async () => {
      fake.loginAs('second@example.com');
      return 0;
    };
    const ctx = { vault, provider: fake.provider() };
    const res = await addViaLogin(ctx, 'second');
    expect(res.profile.email).toBe('second@example.com');
    expect(fake.currentEmail()).toBe('second@example.com');
    expect(vault.manifest.active['agy']).toBe(res.profile.id);
  });

  it('reports a TUI that exits without logging in', async () => {
    const fake = new FakeAgy();
    const { vault } = await newVault();
    fake.loginImpl = async () => 0;
    const ctx = { vault, provider: fake.provider() };
    await expect(addViaLogin(ctx, 'second')).rejects.toMatchObject({
      code: 'E_LOGIN',
      hint: expect.stringContaining('/login'),
    });
    expect(fake.currentEmail()).toBeNull();
  });

  it('verifies through agy models and reports mismatches', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs(EMAIL);
    expect(await ctx.provider.verifyLive({ email: EMAIL })).toMatchObject({ ok: true, email: EMAIL });
    expect(await ctx.provider.verifyLive({ email: 'other@example.com' })).toMatchObject({ ok: false });

    fake.modelsCode = 1;
    fake.modelsError = 'token refresh failed';
    const failed = await ctx.provider.verifyLive({ email: EMAIL });
    expect(failed).toMatchObject({ ok: false });
    expect(failed.detail).toContain('token refresh failed');
  });

  it('skips verification when agy is not installed', async () => {
    const { fake } = await setup();
    fake.loginAs(EMAIL);
    const provider = new AgyProvider({
      env: fake.env,
      keyring: fake.keyring,
      agyBin: 'agy',
      processEnv: { PATH: '' },
      findProcesses: async () => [],
    });
    const res = await provider.verifyLive({ email: EMAIL });
    expect(res).toMatchObject({ ok: true, skipped: true });
    expect(res.detail).toContain('not found on PATH');
  });

  it('fails clearly when agy is not installed', async () => {
    const { fake } = await setup();
    const provider = new AgyProvider({
      env: fake.env,
      keyring: fake.keyring,
      agyBin: 'agy',
      processEnv: { PATH: '' },
      findProcesses: async () => [],
    });
    await expect(provider.login()).rejects.toMatchObject({ code: 'E_NO_AGY' });
  });

  it('refuses to operate while agy is running unless forced', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs(EMAIL);
    const work = await addFromLive(ctx, 'work');
    fake.running = [{ pid: 42, name: 'agy.exe' }];
    await expect(switchTo(ctx, work)).rejects.toMatchObject({ code: 'E_RUNNING' });
    await switchTo(ctx, work, { force: true });
    expect(fake.currentEmail()).toBe(EMAIL);
  });
});

describe('Antigravity preflight', () => {
  it('refuses credential overrides and gateway credentials', async () => {
    const { fake } = await setup();
    const pathOnly = { PATH: process.env.PATH ?? '' };
    for (const key of [
      'AGY_ADC_AUTH',
      'GEMINI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'ANTIGRAVITY_OAUTH_CREDENTIALS_JSON',
      'AGY_ACCOUNT',
      'AGY_LLM_GATEWAY_URL',
    ]) {
      const provider = fake.provider({ ...pathOnly, [key]: 'value' });
      await expect(provider.preflight()).rejects.toMatchObject({ code: 'E_ENV_OVERRIDE' });
    }
    await expect(fake.provider({ ...pathOnly, AGY_ACCOUNT: '  ' }).preflight()).resolves.toBeUndefined();
  });

  it('refuses SSH sessions because agy falls back to a file credential', async () => {
    const { fake } = await setup();
    const provider = fake.provider({ PATH: process.env.PATH ?? '', SSH_TTY: '/dev/pts/1' });
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'E_AGY_FILE_MODE' });
  });

  it('requires an OS credential store', async () => {
    const { fake } = await setup();
    const unavailable: KeyringBackend = {
      kind: 'none',
      available: async () => ({ ok: false, detail: 'no secret service' }),
      read: async () => null,
      write: async () => undefined,
      delete: async () => false,
    };
    const provider = new AgyProvider({
      env: fake.env,
      keyring: unavailable,
      agyBin: fake.bin,
      processEnv: { PATH: process.env.PATH ?? '' },
      findProcesses: async () => [],
    });
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'E_KEYRING' });
  });

  it('launches the TUI itself, with a manual fallback', () => {
    const provider = getProvider('agy');
    expect(provider.capabilities).toEqual({
      login: { email: false, sso: false, console: false, host: false },
      automatedLogin: true,
      manualLogin: true,
      usage: false,
      portableExport: true,
    });
    expect(getProvider('antigravity').id).toBe('agy');
  });
});

describe('Antigravity snapshot validation', () => {
  it('accepts a captured snapshot and refuses malformed ones', async () => {
    const { fake, ctx } = await setup();
    fake.loginAs(EMAIL);
    const snap = (await ctx.provider.readLive())!;
    expect(await ctx.provider.validateSnapshot(snap)).toEqual({ ok: true });
    expect(await ctx.provider.validateSnapshot({ v: 2 } as unknown as AgySnapshot)).toMatchObject({ ok: false });
    expect(await ctx.provider.validateSnapshot({ v: 1, credential: '!!!' })).toMatchObject({ ok: false });
    expect(
      await ctx.provider.validateSnapshot({ v: 1, credential: Buffer.from('{}').toString('base64') }),
    ).toMatchObject({ ok: false });
  });
});

describe('Antigravity export / import', () => {
  it('moves a profile to another machine', async () => {
    const source = await setup();
    source.fake.loginAs(EMAIL);
    const meta = await addFromLive(source.ctx, 'work');
    const text = await exportProfiles(source.vault, [meta], 'export passphrase 1');

    const target = await setup();
    const res = await importProfiles(target.vault, text, 'export passphrase 1', {
      validateSnapshot: (m, snapshot) => target.ctx.provider.validateSnapshot(snapshot as AgySnapshot),
    });
    expect(res.imported.map((p) => p.name)).toEqual(['work']);
    expect(res.imported[0]!.email).toBe(EMAIL);
    await switchTo(target.ctx, res.imported[0]!);
    expect(target.fake.currentEmail()).toBe(EMAIL);
  });

  it('skips a profile that is already saved', async () => {
    const { fake, vault, ctx } = await setup();
    fake.loginAs(EMAIL);
    const meta = await addFromLive(ctx, 'work');
    const text = await exportProfiles(vault, [meta], 'export passphrase 1');
    const res = await importProfiles(vault, text, 'export passphrase 1');
    expect(res.imported).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
  });
});
