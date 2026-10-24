import fs from 'node:fs';
import { atomicWrite, readIfExists, removeIfExists } from '../../vault/atomicWrite.js';
import { sha256Hex } from '../../vault/crypto.js';
import { isNodeError, LockerError } from '../../util/errors.js';
import type { QoderEnv } from './env.js';

/** A Qoder login blob is ~1.3 KiB; cap imports so a tampered export cannot exhaust memory. */
export const MAX_QODER_SNAPSHOT_BYTES = 1024 * 1024;

/**
 * Qoder stores the entire login in one opaque file. It is machine-bound: it can only be
 * read while .auth/machine_id is the same value that existed when qodercli wrote it.
 */
export class QoderStore {
  readonly kind = 'file';
  constructor(readonly env: QoderEnv) {}

  get location(): string {
    return this.env.userFile;
  }

  async readUser(): Promise<Buffer | null> {
    try {
      const stat = await fs.promises.stat(this.env.userFile);
      if (stat.size > MAX_QODER_SNAPSHOT_BYTES) {
        throw new LockerError(`Qoder credential at ${this.location} is larger than ${MAX_QODER_SNAPSHOT_BYTES} bytes.`, 'E_STORE');
      }
      const data = await fs.promises.readFile(this.env.userFile);
      return data.length > 0 ? data : null;
    } catch (err) {
      if (err instanceof LockerError) throw err;
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      throw new LockerError(`Could not read Qoder credentials at ${this.location}.`, 'E_STORE', (err as Error).message);
    }
  }

  async writeUser(data: Buffer): Promise<void> {
    if (data.length === 0) throw new LockerError('Refusing to write an empty Qoder credential.', 'E_STORE');
    if (data.length > MAX_QODER_SNAPSHOT_BYTES) {
      throw new LockerError(`Qoder credential is larger than ${MAX_QODER_SNAPSHOT_BYTES} bytes.`, 'E_STORE');
    }
    await atomicWrite(this.env.userFile, data, 0o600);
  }

  async clearUser(): Promise<void> {
    await removeIfExists(this.env.userFile);
  }

  async machineId(): Promise<string | null> {
    const text = await readIfExists(this.env.machineIdFile);
    const value = text?.trim();
    return value ? value : null;
  }

  async machineIdHash(): Promise<string | undefined> {
    const id = await this.machineId();
    return id ? sha256Hex(`ai-locker-qoder-machine:${id}`).slice(0, 16) : undefined;
  }
}
