import path from 'node:path';
import { findProcesses, type RawProcess } from '../../util/process.js';
import type { RunningProcess } from '../Provider.js';

const COPILOT_SCRIPT = /@github[\\/]copilot[\\/]|[\\/]\.?copilot[\\/].*?cli-main\.js/i;

export type { RawProcess };

/** True for the native Copilot CLI/runtime or a Node process running its bundle. */
export function isCopilotProcess(p: RawProcess): boolean {
  const base = path.win32.basename(path.posix.basename(p.name)).toLowerCase();
  if (base === 'copilot' || base === 'copilot.exe' || base === 'copilot-runtime.exe') return true;
  return COPILOT_SCRIPT.test(p.commandLine);
}

/** Copilot processes that may hold the keyring login in memory and write it back later. */
export function findCopilotProcesses(platform = process.platform): Promise<RunningProcess[]> {
  return findProcesses(isCopilotProcess, { platform, windowsNames: ['copilot.exe', 'copilot-runtime.exe'] });
}
