import os from 'node:os';
import path from 'node:path';

export interface CopilotEnv {
  platform: NodeJS.Platform;
  configDir: string;
  configFile: string;
  settingsFile: string;
  /** Disposable Copilot metadata cache (plan, quota); may not exist. */
  userCacheFile: string;
}

/** Environment variables that replace the stored login. */
export const OVERRIDING_ENV_VARS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
] as const;

/** Set this and Copilot falls back to plaintext storage instead of the OS keyring. */
export const DISABLING_ENV_VARS = ['COPILOT_DISABLE_KEYTAR'] as const;

export function resolveCopilotEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = os.homedir(),
): CopilotEnv {
  // Resolve paths for the target platform, not the host running this code.
  const p = platform === 'win32' ? path.win32 : path.posix;
  const custom = env.COPILOT_HOME?.trim();
  const configDir = custom ? p.resolve(custom) : p.join(home, '.copilot');
  let cacheDir: string;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim();
    cacheDir = local ? p.join(local, 'copilot') : p.join(home, 'AppData', 'Local', 'copilot');
  } else if (platform === 'darwin') {
    cacheDir = p.join(home, 'Library', 'Caches', 'copilot');
  } else {
    const xdg = env.XDG_CACHE_HOME?.trim();
    cacheDir = xdg ? p.join(xdg, 'copilot') : p.join(home, '.cache', 'copilot');
  }
  return {
    platform,
    configDir,
    configFile: p.join(configDir, 'config.json'),
    settingsFile: p.join(configDir, 'settings.json'),
    userCacheFile: p.join(cacheDir, 'copilot-user-cache.json'),
  };
}

/** A copy of the environment that cannot override or bypass the keyring login. */
export function cleanCopilotEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const k of [...OVERRIDING_ENV_VARS, ...DISABLING_ENV_VARS]) delete copy[k];
  return copy;
}
