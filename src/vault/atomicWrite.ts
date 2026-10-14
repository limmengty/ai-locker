import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isNodeError } from '../util/errors.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write a file atomically: temp file in the same directory -> fsync -> rename.
 * A crash mid-write leaves either the old or the new content, never a torn file.
 * Retries the rename on Windows, where antivirus or indexers briefly hold handles.
 */
export async function atomicWrite(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fh = await fs.promises.open(tmp, 'wx', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, file);
      break;
    } catch (err) {
      const retryable = isNodeError(err) && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code ?? '');
      if (attempt < 5 && retryable) {
        await sleep(50 * (attempt + 1));
        continue;
      }
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
  }
  if (process.platform !== 'win32') {
    await fs.promises.chmod(file, mode);
  }
}

export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function removeIfExists(file: string): Promise<boolean> {
  try {
    await fs.promises.unlink(file);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}
