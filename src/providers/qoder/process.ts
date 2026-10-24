import path from 'node:path';
import { findProcesses, type RawProcess } from '../../util/process.js';
import type { RunningProcess } from '../Provider.js';

const QODER_CLI_SCRIPT = /[\\/]qodercli(?:\.exe|\.js)?(?:\s|$)/i;

export type { RawProcess };

/** True for the native qodercli binary or a node/bun process running its CLI script. */
export function isQoderProcess(p: RawProcess): boolean {
  const base = path.win32.basename(path.posix.basename(p.name)).toLowerCase();
  if (base === 'qodercli' || base === 'qodercli.exe') return true;
  return QODER_CLI_SCRIPT.test(p.commandLine);
}

/** Qoder CLI processes that may hold the login in memory and write it back later. */
export function findQoderProcesses(platform = process.platform): Promise<RunningProcess[]> {
  return findProcesses(isQoderProcess, { platform, windowsNames: ['qodercli.exe'] });
}
