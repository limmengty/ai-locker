import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface KiroEnv {
  platform: NodeJS.Platform;
  home: string;
  /** Directory that holds Kiro's SQLite store; the CLI keeps it beside the binary. */
  dataDir: string;
  dbFile: string;
  /** Settings root (`KIRO_HOME` or `~/.kiro`); holds no credentials. */
  settingsDir: string;
}

/** Set this and kiro-cli authenticates from the environment instead of the stored login. */
export const OVERRIDING_ENV_VARS = ['KIRO_API_KEY'] as const;

/** kiro-cli's own test escape hatch; honoured so a switch can be exercised without touching real state. */
const DB_PATH_ENV = 'KIRO_TEST_DB_PATH';

export function resolveKiroEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = os.homedir(),
  binPath: string | null = null,
): KiroEnv {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const settingsDir = env.KIRO_HOME?.trim() ? p.resolve(env.KIRO_HOME) : p.join(home, '.kiro');

  const testDb = env[DB_PATH_ENV]?.trim();
  if (testDb) {
    const dbFile = p.resolve(testDb);
    return { platform, home, dataDir: p.dirname(dbFile), dbFile, settingsDir };
  }

  const candidates = dataDirCandidates(env, platform, home, p, binPath);
  const dataDir = candidates.find((dir) => fs.existsSync(p.join(dir, 'data.sqlite3'))) ?? candidates[0]!;
  return { platform, home, dataDir, dbFile: p.join(dataDir, 'data.sqlite3'), settingsDir };
}

function dataDirCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  p: typeof path.win32 | typeof path.posix,
  binPath: string | null,
): string[] {
  const list: string[] = [];
  if (binPath) list.push(p.dirname(binPath));
  if (platform === 'win32') {
    for (const key of ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
      const base = env[key]?.trim();
      if (base) list.push(p.join(base, 'Kiro-Cli'), p.join(base, 'Programs', 'Kiro-Cli'));
    }
  } else {
    list.push(
      p.join(home, '.kiro'),
      p.join(home, '.local', 'share', 'kiro-cli'),
      ...(platform === 'darwin' ? [p.join(home, 'Library', 'Application Support', 'kiro-cli')] : []),
      '/usr/local/lib/kiro-cli',
    );
  }
  list.push(p.join(home, 'Kiro-Cli'));
  return [...new Set(list)];
}

/** A copy of the environment that cannot override the stored login. */
export function cleanKiroEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const k of OVERRIDING_ENV_VARS) delete copy[k];
  return copy;
}
