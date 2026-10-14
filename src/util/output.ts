const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: number, reset: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[${reset}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export interface OutputOptions {
  json?: boolean;
}

/** Print either a JSON document (machine mode) or human text, never both. */
export function emit(opts: OutputOptions, data: unknown, human: () => void): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    human();
  }
}

/** Human-readable result output (stdout). Only called when not in --json mode. */
export function info(msg: string): void {
  process.stdout.write(msg + '\n');
}

/** Progress and prompts context go to stderr so `--json` stdout stays parseable. */
export function note(msg: string): void {
  process.stderr.write(msg + '\n');
}

export function warn(msg: string): void {
  process.stderr.write(c.yellow('! ') + msg + '\n');
}

export function relTime(ms: number | undefined | null, now = Date.now()): string {
  if (!ms) return 'unknown';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [size, label] of units) {
    if (abs >= size) {
      const text = `${Math.floor(abs / size)}${label}`;
      return diff >= 0 ? `in ${text}` : `${text} ago`;
    }
  }
  return 'now';
}
