import path from 'node:path';
import { findProcesses, type RawProcess } from '../../util/process.js';
import type { RunningProcess } from '../Provider.js';

const CLAUDE_CODE_SCRIPT = /@anthropic-ai[\\/]claude-code|[\\/]claude-code[\\/]cli\.(m?js)/i;

export type { RawProcess };

/** Claude Desktop ships an executable with the same name but doesn't use these credentials. */
const CLAUDE_DESKTOP = /AnthropicClaude[\\/]|Claude\.app[\\/]/;

/** True for the native `claude` binary or a Node/Bun process running Claude Code's CLI script. */
export function isClaudeProcess(p: RawProcess): boolean {
  if (CLAUDE_CODE_SCRIPT.test(p.commandLine)) return true;
  if (CLAUDE_DESKTOP.test(p.name) || CLAUDE_DESKTOP.test(p.commandLine)) return false;
  // POSIX names are case-sensitive (the Desktop app is "Claude"); Windows names are not.
  const base = path.win32.basename(path.posix.basename(p.name));
  return base === 'claude' || base.toLowerCase() === 'claude.exe';
}

/** Processes that may hold Claude Code credentials in memory and write them back later. */
export function findClaudeProcesses(platform = process.platform): Promise<RunningProcess[]> {
  return findProcesses(isClaudeProcess, { platform, windowsNames: ['claude.exe'] });
}
