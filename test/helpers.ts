import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockerPaths } from '../src/util/paths.js';
import { Vault } from '../src/vault/vault.js';
import { ClaudeCodeProvider, type ClaudeSnapshot } from '../src/providers/claude-code/index.js';
import { FileStore } from '../src/providers/claude-code/credentialStore.js';
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

export type { ClaudeSnapshot };
