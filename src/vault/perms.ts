import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Create a directory readable only by the current user.
 * POSIX: mode 0700. Windows: drop inherited ACEs and grant only the current user,
 * inherited by every file created inside it.
 */
export function ensurePrivateDir(dir: string): { hardened: boolean; detail?: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
    return { hardened: true };
  }
  const res = spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${windowsAccount()}:(OI)(CI)F`], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    return { hardened: false, detail: (res.stderr || res.stdout || '').trim() };
  }
  return { hardened: true };
}

/** Best-effort check that nobody besides the current user can read the directory. */
export function describeDirAccess(dir: string): { ok: boolean; detail: string } {
  if (process.platform !== 'win32') {
    const mode = fs.statSync(dir).mode & 0o777;
    return { ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8).padStart(3, '0')}` };
  }
  const res = spawnSync('icacls', [dir], { windowsHide: true, encoding: 'utf8' });
  if (res.status !== 0) return { ok: false, detail: 'icacls failed' };
  const user = windowsAccount().toLowerCase();
  const aces = res.stdout
    .split(/\r?\n/)
    .map((l) => l.replace(dir, '').trim())
    .filter((l) => /:\(/.test(l));
  const others = aces.filter((l) => !l.toLowerCase().startsWith(user + ':'));
  return { ok: others.length === 0, detail: aces.join('; ') };
}

function windowsAccount(): string {
  const name = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}
