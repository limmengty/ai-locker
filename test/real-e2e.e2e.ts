import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyringBackend, type KeyringRef } from '../src/util/keyring.js';
import { resolveCopilotEnv } from '../src/providers/copilot/env.js';
import { parseCopilotConfig, readActiveUser, type CopilotUser } from '../src/providers/copilot/config.js';
import { parseAgyCredential } from '../src/providers/antigravity/credential.js';

/**
 * Helpers for the manual real-account E2E. This file is not matched by the normal test
 * glob; run it explicitly. It never prints credential bytes.
 *
 *   E2E_MODE=backup  E2E_BACKUP_DIR=<dir> npx vitest run test/real-e2e.e2e.ts
 *   E2E_MODE=verify  E2E_BACKUP_DIR=<dir> npx vitest run test/real-e2e.e2e.ts
 *   E2E_MODE=rescue  E2E_BACKUP_DIR=<dir> npx vitest run test/real-e2e.e2e.ts
 */

interface SavedItem {
  ref: KeyringRef;
  secret: string;
  persist?: number;
  comment?: string;
}

interface Backup {
  createdAt: string;
  copilot: { configPath: string; config: string | null; items: SavedItem[] };
  agy: { items: SavedItem[] };
}

const AGY_REF: KeyringRef = {
  service: 'gemini',
  account: 'antigravity',
  windowsTarget: 'gemini:antigravity',
};

function copilotRefs(config: CopilotUser | null): KeyringRef[] {
  if (!config) return [];
  const base = `${config.host}:${config.login}`;
  return [base, `${base}:github`].map((account) => ({
    service: 'copilot-cli',
    account,
    windowsTarget: `${account}.copilot-cli`,
  }));
}

function copilotActive(configText: string | null): CopilotUser | null {
  return configText === null ? null : readActiveUser(parseCopilotConfig(configText));
}

async function readItems(backend: ReturnType<typeof keyringBackend>, refs: KeyringRef[]): Promise<SavedItem[]> {
  const out: SavedItem[] = [];
  for (const ref of refs) {
    const entry = await backend.read(ref);
    if (entry) {
      out.push({
        ref,
        secret: entry.secret.toString('base64'),
        persist: entry.persist,
        comment: entry.comment,
      });
    }
  }
  return out;
}

async function makeBackup(): Promise<Backup> {
  const backend = keyringBackend();
  const copilotEnv = resolveCopilotEnv();
  const config = fs.existsSync(copilotEnv.configFile) ? fs.readFileSync(copilotEnv.configFile, 'utf8') : null;
  return {
    createdAt: new Date().toISOString(),
    copilot: {
      configPath: copilotEnv.configFile,
      config,
      items: await readItems(backend, copilotRefs(copilotActive(config))),
    },
    agy: { items: await readItems(backend, [AGY_REF]) },
  };
}

async function restore(backup: Backup): Promise<void> {
  const backend = keyringBackend();
  for (const item of [...backup.copilot.items, ...backup.agy.items]) {
    await backend.write({
      ...item.ref,
      secret: Buffer.from(item.secret, 'base64'),
      persist: item.persist ?? 2,
      comment: item.comment,
    });
  }
  if (backup.copilot.config !== null && fs.existsSync(path.dirname(backup.copilot.configPath))) {
    fs.writeFileSync(backup.copilot.configPath, backup.copilot.config);
  }
}

function backupDir(): string {
  const dir = process.env.E2E_BACKUP_DIR;
  if (!dir) throw new Error('E2E_BACKUP_DIR is required');
  return dir;
}

describe('real account backup tooling', () => {
  it(`runs ${process.env.E2E_MODE ?? 'nothing'}`, async () => {
    const mode = process.env.E2E_MODE;
    if (mode === 'backup') {
      const dir = backupDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const backup = await makeBackup();
      fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(backup), { mode: 0o600 });
      console.log(
        JSON.stringify({
          saved: {
            dir,
            copilot: {
              active: copilotActive(backup.copilot.config)?.login ?? null,
              items: backup.copilot.items.length,
            },
            agy: {
              email: backup.agy.items[0]
                ? parseAgyCredential(Buffer.from(backup.agy.items[0].secret, 'base64')).email ?? null
                : null,
              items: backup.agy.items.length,
            },
          },
        }),
      );
      return;
    }

    if (mode !== 'verify' && mode !== 'rescue') {
      throw new Error('E2E_MODE must be backup, verify or rescue');
    }
    const backup = JSON.parse(fs.readFileSync(path.join(backupDir(), 'backup.json'), 'utf8')) as Backup;

    if (mode === 'rescue') {
      await restore(backup);
      console.log(JSON.stringify({ rescued: true }));
      return;
    }

    const backend = keyringBackend();
    const copilotEnv = resolveCopilotEnv();
    const currentConfig = fs.existsSync(copilotEnv.configFile) ? fs.readFileSync(copilotEnv.configFile, 'utf8') : null;
    const currentActive = copilotActive(currentConfig);
    const expectedActive = copilotActive(backup.copilot.config);

    const currentCopilot = await readItems(backend, copilotRefs(expectedActive));
    const expectedCopilot = new Map(backup.copilot.items.map((i) => [i.ref.account, i.secret]));
    const copilotStatus = currentCopilot.map((i) => ({
      account: i.ref.account,
      present: true,
      token: expectedCopilot.get(i.ref.account) === i.secret ? 'unchanged' : 'rotated',
    }));
    const missingCopilot = backup.copilot.items
      .map((i) => i.ref.account)
      .filter((account) => !currentCopilot.some((i) => i.ref.account === account));

    const currentAgy = await readItems(backend, [AGY_REF]);
    const expectedAgy = backup.agy.items[0];
    const agyStatus = currentAgy[0]
      ? {
          email: parseAgyCredential(Buffer.from(currentAgy[0].secret, 'base64')).email ?? null,
          token: expectedAgy && expectedAgy.secret === currentAgy[0].secret ? 'unchanged' : 'rotated',
        }
      : null;

    console.log(
      JSON.stringify({
        copilot: {
          active: currentActive?.login ?? null,
          matches: Boolean(currentActive && expectedActive && currentActive.login === expectedActive.login),
          items: copilotStatus,
          missing: missingCopilot,
        },
        agy: { credential: agyStatus },
      }),
    );

    expect(currentActive?.login ?? null).toBe(expectedActive?.login ?? null);
    if (backup.copilot.items.length > 0) {
      expect(currentCopilot.length).toBeGreaterThan(0);
      expect(missingCopilot).toEqual([]);
    }
    if (expectedAgy) {
      expect(currentAgy.length).toBe(1);
      expect(agyStatus?.email ?? null).toBe(
        parseAgyCredential(Buffer.from(expectedAgy.secret, 'base64')).email ?? null,
      );
    }
  });
});
