import { atomicWrite, readIfExists, removeIfExists } from '../../vault/atomicWrite.js';
import { run } from '../../util/exec.js';
import { LockerError } from '../../util/errors.js';

/** Where Claude Code keeps its credentials JSON (as text, exactly as Claude wrote it). */
export interface CredentialStore {
  readonly kind: string;
  readonly location: string;
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
  clear(): Promise<void>;
}

/** Windows, Linux, and the macOS fallback: <configDir>/.credentials.json. */
export class FileStore implements CredentialStore {
  readonly kind = 'file';
  constructor(readonly location: string) {}

  async read(): Promise<string | null> {
    const text = await readIfExists(this.location);
    return text && text.trim() ? text : null;
  }

  async write(json: string): Promise<void> {
    // Mode 0600 matches what Claude Code itself writes. On Windows the file inherits the
    // user-only ACL of the profile directory, same as Claude Code's own file.
    await atomicWrite(this.location, json, 0o600);
  }

  async clear(): Promise<void> {
    await removeIfExists(this.location);
  }
}

const SECURITY = '/usr/bin/security';
const ITEM_NOT_FOUND = 44;
/** `security -i` reads commands with a fixed-size line buffer; stay well under it. */
const MAX_INTERACTIVE_LINE = 3800;

/**
 * macOS login Keychain, generic password item `Claude Code-credentials[-hash]`.
 * The password is the credentials JSON. If the Keychain is missing an entry but the
 * fallback file exists (Keychain was locked when Claude wrote), the file is used.
 */
export class KeychainStore implements CredentialStore {
  readonly kind = 'macOS Keychain';
  constructor(
    readonly service: string,
    readonly account: string,
    readonly fallback: FileStore,
  ) {}

  get location(): string {
    return `Keychain item "${this.service}" (fallback ${this.fallback.location})`;
  }

  async read(): Promise<string | null> {
    const res = await run(SECURITY, ['find-generic-password', '-s', this.service, '-w'], { timeoutMs: 60_000 });
    if (res.code === 0 && res.stdout.trim()) return res.stdout.replace(/\n$/, '');
    if (res.code !== 0 && res.code !== ITEM_NOT_FOUND) {
      throw new LockerError('Could not read Claude Code credentials from the Keychain.', 'E_STORE', res.stderr.trim());
    }
    return this.fallback.read();
  }

  async write(json: string): Promise<void> {
    const oneLine = JSON.stringify(JSON.parse(json));
    const hex = Buffer.from(oneLine, 'utf8').toString('hex');
    // Remove items under any account name first so exactly one item answers `-s <service>`.
    // The previous contents are already saved in the vault's rollback record.
    await this.deleteAllItems();
    const line = `add-generic-password -U -s "${this.service}" -a "${this.account}" -X ${hex}\n`;
    const res =
      line.length <= MAX_INTERACTIVE_LINE
        ? await run(SECURITY, ['-i'], { input: line, timeoutMs: 60_000 })
        : // Large payloads (many MCP connector tokens) exceed the -i buffer. argv is only
          // visible to processes of the same user, which can already query the Keychain.
          await run(SECURITY, ['add-generic-password', '-U', '-s', this.service, '-a', this.account, '-X', hex], {
            timeoutMs: 60_000,
          });
    if (res.code !== 0 || /error/i.test(res.stderr)) {
      throw new LockerError('Could not write Claude Code credentials to the Keychain.', 'E_STORE', res.stderr.trim());
    }
    // A stale fallback file would hold another account's tokens; the Keychain is now authoritative.
    await this.fallback.clear();
  }

  async clear(): Promise<void> {
    await this.deleteAllItems();
    await this.fallback.clear();
  }

  private async deleteAllItems(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const res = await run(SECURITY, ['delete-generic-password', '-s', this.service], { timeoutMs: 30_000 });
      if (res.code === ITEM_NOT_FOUND) break;
      if (res.code !== 0) {
        throw new LockerError('Could not remove Claude Code credentials from the Keychain.', 'E_STORE', res.stderr.trim());
      }
    }
  }
}
