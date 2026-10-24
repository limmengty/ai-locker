import path from 'node:path';
import { run } from './exec.js';
import type { RunningProcess } from '../providers/Provider.js';

export interface RawProcess {
  pid: number;
  name: string;
  commandLine: string;
}

export interface ListProcessOptions {
  platform?: NodeJS.Platform;
  /** Executable names (without node/bun) that the platform command should include. */
  windowsNames?: string[];
}

/** Enumerate processes with their command lines, skipping this process. */
export async function findProcesses(
  match: (p: RawProcess) => boolean,
  opts: ListProcessOptions = {},
): Promise<RunningProcess[]> {
  const all = await listProcesses(opts);
  return all.filter((p) => p.pid !== process.pid && Number.isFinite(p.pid) && match(p)).map(({ pid, name }) => ({ pid, name }));
}

export async function listProcesses(opts: ListProcessOptions = {}): Promise<RawProcess[]> {
  return (opts.platform ?? process.platform) === 'win32' ? listWindows(opts.windowsNames ?? []) : listPosix();
}

const WIN_NAME = /^[A-Za-z0-9_.-]+$/;

async function listWindows(extraNames: string[]): Promise<RawProcess[]> {
  const names = [...new Set([...extraNames, 'node.exe', 'bun.exe'])].filter((n) => WIN_NAME.test(n));
  const filter = names.map((n) => `Name='${n}'`).join(' OR ');
  const ps = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($_.CommandLine)" }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const res = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeoutMs: 30_000,
  });
  return res.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid = '', name = '', ...rest] = line.split('\t');
      return { pid: Number(pid), name, commandLine: rest.join('\t') };
    })
    .filter((p) => Number.isFinite(p.pid));
}

async function listPosix(): Promise<RawProcess[]> {
  const res = await run('ps', ['-axo', 'pid=,comm=,args='], { timeoutMs: 30_000 });
  return res.stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), name: m[2] ?? '', commandLine: m[3] ?? '' }));
}
