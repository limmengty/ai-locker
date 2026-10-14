import { darwinCache } from './darwin.js';
import { win32Cache } from './win32.js';

/**
 * An OS-protected copy of the vault data key (VDK), so routine commands don't need the
 * passphrase. It only decrypts for the same OS user on the same machine; a copy of
 * ~/.ai-locker taken elsewhere is useless without the passphrase.
 */
export interface OsKeyCache {
  readonly name: string;
  store(vaultId: string, vdk: Buffer): Promise<void>;
  load(vaultId: string): Promise<Buffer | null>;
  clear(vaultId: string): Promise<void>;
  exists(vaultId: string): Promise<boolean>;
}

/** Returns null on platforms without a supported OS secret store (e.g. Linux). */
export function osKeyCache(blobPath: string, platform = process.platform): OsKeyCache | null {
  if (platform === 'win32') return win32Cache(blobPath);
  if (platform === 'darwin') return darwinCache();
  return null;
}
