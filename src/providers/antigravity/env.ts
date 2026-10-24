import os from 'node:os';
import path from 'node:path';

export interface AgyEnv {
  platform: NodeJS.Platform;
  /** ~/.gemini: root shared with other Gemini tooling. */
  geminiDir: string;
  /** ~/.gemini/antigravity-cli: Antigravity CLI state. */
  stateDir: string;
  /** ~/.gemini/config: shared model/config cache. */
  configDir: string;
}

/** Variables that make agy authenticate with something other than the keyring login. */
export const OVERRIDING_ENV_VARS = [
  'AGY_ADC_AUTH',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTIGRAVITY_OAUTH_CREDENTIALS_JSON',
  'AGY_ACCOUNT',
] as const;

/** Gateway credentials select their own upstream account. */
export const GATEWAY_ENV_PREFIX = 'AGY_LLM_GATEWAY_';

/** agy stores the login in a file instead of the keyring when these are set or when run as root. */
export const FILE_FALLBACK_ENV_VARS = ['SSH_TTY'] as const;

/**
 * agy keeps its state under ~/.gemini (or %USERPROFILE%\.gemini). In 1.4.7 the
 * ANTIGRAVITY_* directory variables did not relocate it; only HOME/USERPROFILE did.
 */
export function resolveAgyEnv(platform = process.platform, home = os.homedir()): AgyEnv {
  const geminiDir = path.join(home, '.gemini');
  return {
    platform,
    geminiDir,
    stateDir: path.join(geminiDir, 'antigravity-cli'),
    configDir: path.join(geminiDir, 'config'),
  };
}

/** A copy of the environment without credential overrides, for spawning agy. */
export function cleanAgyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const k of OVERRIDING_ENV_VARS) delete copy[k];
  for (const k of Object.keys(copy)) {
    if (k.startsWith(GATEWAY_ENV_PREFIX)) delete copy[k];
  }
  return copy;
}
