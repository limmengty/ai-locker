import os from 'node:os';
import path from 'node:path';
import { LockerError } from '../../util/errors.js';

export interface QoderEnv {
  platform: NodeJS.Platform;
  /** Directory holding .auth, settings.json, state.json... */
  configDir: string;
  authDir: string;
  /** Opaque login blob written by qodercli. */
  userFile: string;
  /** Device-bound UUID required to read the login blob. */
  machineIdFile: string;
  transactionFile: string;
}

/** Environment variables that make qodercli ignore the saved login. */
export const OVERRIDING_ENV_VARS = [
  'QODER_PERSONAL_ACCESS_TOKEN',
  'QODER_JOB_TOKEN',
  'QODER_SERVICE_ACCOUNT_KEY',
] as const;

/**
 * Mirrors qodercli 1.1.78: QODER_CONFIG_DIR is a full path, QODER_CONFIG_DIR_NAME is a
 * directory name under the home directory, and the default is ~/.qoder.
 * The global build ignores QODERCN_CONFIG_DIR; a CN build may need its own handling.
 */
export function resolveQoderEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = os.homedir(),
): QoderEnv {
  const customDir = env.QODER_CONFIG_DIR?.trim();
  const customName = env.QODER_CONFIG_DIR_NAME?.trim();

  let configDir: string;
  if (customDir) {
    configDir = path.resolve(customDir);
  } else if (customName) {
    if (!isSafeDirName(customName)) {
      throw new LockerError(`QODER_CONFIG_DIR_NAME is not a valid directory name: ${JSON.stringify(customName)}.`, 'E_ENV');
    }
    configDir = path.join(home, customName);
  } else {
    configDir = path.join(home, '.qoder');
  }

  const authDir = path.join(configDir, '.auth');
  return {
    platform,
    configDir,
    authDir,
    userFile: path.join(authDir, 'user'),
    machineIdFile: path.join(authDir, 'machine_id'),
    transactionFile: path.join(authDir, '.credential-transaction'),
  };
}

function isSafeDirName(name: string): boolean {
  return (
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name) &&
    !/^\s/.test(name) &&
    !/\s$/.test(name)
  );
}

/** A copy of the environment without credential overrides, for spawning qodercli. */
export function cleanQoderEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const k of OVERRIDING_ENV_VARS) delete copy[k];
  return copy;
}
