import path from 'node:path';
import { findProcesses, type RawProcess } from '../../util/process.js';
import type { RunningProcess } from '../Provider.js';

/** The TUI runs as a bun/node process loading tui.js from the Kiro install directory. */
const KIRO_TUI_SCRIPT = /(?:^|[\s/\\'"=])tui\.js/i;

export type { RawProcess };

/** Base names: `kiro-cli(.exe)`, and install layouts that ship `kiro-cli-chat.exe` / `kiro-cli-internal-*.exe`. */
function isKiroBinary(name: string): boolean {
  const base = path.win32.basename(path.posix.basename(name)).toLowerCase();
  return base === 'kiro-cli' || base === 'kiro-cli.exe' || base.startsWith('kiro-cli-');
}

/** True for the native kiro-cli binary or a node/bun process running its TUI script. */
export function isKiroProcess(p: RawProcess): boolean {
  if (isKiroBinary(p.name)) return true;
  return KIRO_TUI_SCRIPT.test(p.commandLine);
}

/** Kiro CLI processes that may hold the login in memory and write it back later. */
export function findKiroProcesses(platform = process.platform): Promise<RunningProcess[]> {
  return findProcesses(isKiroProcess, {
    platform,
    windowsNames: [
      'kiro-cli.exe',
      'kiro-cli-chat.exe',
      'kiro-cli-internal-auth.exe',
      'kiro-cli-internal-chat.exe',
      'kiro-cli-internal-code.exe',
    ],
  });
}
