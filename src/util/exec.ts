import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Invocation {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Locate an executable by walking absolute PATH entries only. Unlike `where`, this never
 * looks in the current directory, so a `claude.exe` planted in a cloned repo can't run.
 * On Windows, a real .exe anywhere on PATH wins over npm's .cmd shim.
 */
export function resolveExecutable(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (p.isAbsolute(cmd)) return isFile(cmd) ? cmd : null;
  if (/[\\/]/.test(cmd)) return null; // relative paths are never trusted
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && p.isAbsolute(d));
  if (platform !== 'win32') {
    for (const d of dirs) {
      const candidate = p.join(d, cmd);
      if (isFile(candidate)) return candidate;
    }
    return null;
  }
  const hasExt = /\.(exe|cmd|bat)$/i.test(cmd);
  for (const ext of hasExt ? [''] : ['.exe', '.cmd', '.bat']) {
    for (const d of dirs) {
      const candidate = p.join(d, cmd + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(f: string): boolean {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

/**
 * .cmd/.bat files can only run through cmd.exe. Arguments are restricted to characters
 * cmd.exe does not interpret, then quoted, so no argument can inject a command.
 */
function invocation(file: string, args: string[]): Invocation {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  for (const a of [file, ...args]) {
    if (/[%^&|<>"!\r\n]/.test(a)) throw new Error(`refusing to pass unsafe argument to cmd.exe: ${a}`);
  }
  const quote = (s: string) => (/^[A-Za-z0-9_\-.:\\/@=+]+$/.test(s) ? s : `"${s}"`);
  const line = [file, ...args].map(quote).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Run a program without a shell and capture its output. Secrets must only ever travel
 * through `input` (stdin), never through `args`, because argv is visible to other processes.
 */
export function run(
  file: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const inv = invocation(file, args);
    const child = spawn(inv.file, inv.args, {
      env: opts.env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
    child.stdout!.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr!.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin!.on('error', () => {
      /* child exited before reading stdin; surfaced via exit code */
    });
    child.stdin!.end(opts.input ?? '');
  });
}

/**
 * Run an interactive program attached to the user's terminal. Ctrl+C reaches the child
 * (same console / process group) while this process ignores it, so the caller always
 * gets to run its restore logic instead of dying mid-operation.
 */
export function runInteractive(file: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const ignore = () => {};
  process.on('SIGINT', ignore);
  return new Promise<number>((resolve, reject) => {
    const inv = invocation(file, args);
    const child = spawn(inv.file, inv.args, {
      env: opts.env ?? process.env,
      stdio: 'inherit',
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  }).finally(() => process.off('SIGINT', ignore));
}
