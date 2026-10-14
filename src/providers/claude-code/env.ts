import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ClaudeEnv {
  platform: NodeJS.Platform;
  /** Directory holding .credentials.json, settings, projects... */
  configDir: string;
  /** File holding `oauthAccount` and other global state (~/.claude.json by default). */
  globalConfigPath: string;
  keychainService: string;
  keychainAccount: string;
}

const KEYCHAIN_BASE = 'Claude Code-credentials';

export function resolveClaudeEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ClaudeEnv {
  const custom = env.CLAUDE_CONFIG_DIR;
  const configDir = custom || path.join(os.homedir(), '.claude');
  const globalConfigPath = custom ? path.join(custom, '.claude.json') : path.join(os.homedir(), '.claude.json');
  return {
    platform,
    configDir,
    globalConfigPath,
    keychainService: keychainServiceName(env),
    keychainAccount: env.USER || os.userInfo().username,
  };
}

/**
 * Mirrors Claude Code's own derivation (verified against the 2.1.28x binary):
 *  - CLAUDE_SECURESTORAGE_CONFIG_DIR set and empty  -> bare name
 *  - CLAUDE_SECURESTORAGE_CONFIG_DIR set            -> name + "-" + sha256(NFC(value))[0..8]
 *  - CLAUDE_CONFIG_DIR set                          -> name + "-" + sha256(NFC(value))[0..8]
 *  - neither                                        -> bare name
 */
export function keychainServiceName(env: NodeJS.ProcessEnv): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = secure !== undefined ? secure : env.CLAUDE_CONFIG_DIR;
  if (!dir) return KEYCHAIN_BASE;
  const hash = crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${KEYCHAIN_BASE}-${hash}`;
}

/** Environment variables that make Claude Code ignore the stored login entirely. */
export const OVERRIDING_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/** A copy of the environment without credential overrides, for spawning `claude`. */
export function cleanClaudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const k of OVERRIDING_ENV_VARS) delete copy[k];
  return copy;
}
