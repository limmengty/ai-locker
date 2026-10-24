import { LockerError } from '../../util/errors.js';
import type { KeyringBackend, KeyringItem, KeyringRef } from '../../util/keyring.js';
import { MAX_AGY_CREDENTIAL_BYTES } from './credential.js';

/**
 * agy uses go-keyring: service `gemini`, account `antigravity`. On Windows that maps to
 * the generic credential target `gemini:antigravity` with persistence "local machine".
 */
export const AGY_KEYRING_SERVICE = 'gemini';
export const AGY_KEYRING_ACCOUNT = 'antigravity';
export const AGY_WINDOWS_TARGET = `${AGY_KEYRING_SERVICE}:${AGY_KEYRING_ACCOUNT}`;

export class AgyStore {
  readonly kind = 'keyring';
  constructor(private readonly keyring: KeyringBackend) {}

  get location(): string {
    return `${AGY_WINDOWS_TARGET} (${this.keyring.kind})`;
  }

  ref(): KeyringRef {
    return {
      service: AGY_KEYRING_SERVICE,
      account: AGY_KEYRING_ACCOUNT,
      windowsTarget: AGY_WINDOWS_TARGET,
    };
  }

  async read(): Promise<Buffer | null> {
    const entry = await this.keyring.read(this.ref());
    return entry && entry.secret.length > 0 ? entry.secret : null;
  }

  async write(data: Buffer): Promise<void> {
    if (data.length === 0) {
      throw new LockerError('Refusing to write an empty Antigravity credential.', 'E_STORE');
    }
    if (data.length > MAX_AGY_CREDENTIAL_BYTES) {
      throw new LockerError(
        `Antigravity credential is larger than ${MAX_AGY_CREDENTIAL_BYTES} bytes.`,
        'E_STORE',
      );
    }
    const item: KeyringItem = {
      ...this.ref(),
      secret: data,
      persist: 2,
      label: 'Antigravity CLI login',
    };
    await this.keyring.write(item);
  }

  async clear(): Promise<boolean> {
    return this.keyring.delete(this.ref());
  }
}
