import path from 'node:path';
import { run } from '../../util/exec.js';
import type { RunningProcess } from '../Provider.js';

const CLAUDE_CODE_SCRIPT = /@anthropic-ai[\\/]claude-code|[\\/]claude-code[\\/]cli\.(m?js)/i;

interface RawProcess {
  pid: number;
  name: string;
  commandLine: string;
}

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
export async function findClaudeProcesses(platform = process.platform): Promise<RunningProcess[]> {
  const all = platform === 'win32' ? await listWindows() : await listPosix();
  return all.filter((p) => p.pid !== process.pid && isClaudeProcess(p)).map(({ pid, name }) => ({ pid, name }));
}

async function listWindows(): Promise<RawProcess[]> {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='node.exe' OR Name='bun.exe'\" | " +
    'ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
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
