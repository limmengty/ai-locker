import path from 'node:path';
import { findProcesses, type RawProcess } from '../../util/process.js';
import type { RunningProcess } from '../Provider.js';

const AGY_COMMAND = /[\\/]agy(?:\.exe)?(?:\s|$)/i;

/** The Antigravity IDE is a separate app and does not use the CLI keyring. */
export function isAgyProcess(p: RawProcess): boolean {
  const base = path.win32.basename(path.posix.basename(p.name)).toLowerCase();
  if (base === 'agy' || base === 'agy.exe') return true;
  return AGY_COMMAND.test(p.commandLine);
}

export function findAgyProcesses(platform = process.platform): Promise<RunningProcess[]> {
  return findProcesses(isAgyProcess, { platform, windowsNames: ['agy.exe'] });
}
