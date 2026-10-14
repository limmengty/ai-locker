import fs from 'node:fs';
import { atomicWrite, readIfExists } from '../../vault/atomicWrite.js';
import { LockerError } from '../../util/errors.js';

export type OAuthAccount = Record<string, unknown>;

/**
 * Reads and replaces only the `oauthAccount` key of Claude Code's global config
 * (~/.claude.json). Every other key keeps its value and position; indentation and the
 * trailing newline are preserved.
 */
export class IdentityStore {
  constructor(readonly path: string) {}

  async read(): Promise<OAuthAccount | null> {
    const doc = await this.load();
    const acct = doc?.data.oauthAccount;
    return acct && typeof acct === 'object' ? (acct as OAuthAccount) : null;
  }

  async write(account: OAuthAccount | null): Promise<void> {
    const doc = (await this.load()) ?? { data: {}, indent: 2, newline: true, mode: 0o600 };
    if (account) {
      doc.data.oauthAccount = account;
    } else {
      delete doc.data.oauthAccount;
    }
    const text = JSON.stringify(doc.data, null, doc.indent) + (doc.newline ? '\n' : '');
    await atomicWrite(this.path, text, doc.mode);
  }

  private async load(): Promise<{ data: Record<string, unknown>; indent: number | string; newline: boolean; mode: number } | null> {
    const raw = await readIfExists(this.path);
    if (raw === null) return null;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new LockerError(
        `${this.path} is not valid JSON; refusing to modify it.`,
        'E_CLAUDE_CONFIG',
        'Start and quit Claude Code once so it rewrites the file, then retry.',
      );
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new LockerError(`${this.path} has an unexpected shape; refusing to modify it.`, 'E_CLAUDE_CONFIG');
    }
    const indentMatch = raw.match(/^\{\r?\n([ \t]+)"/);
    const indent = indentMatch?.[1] ? (indentMatch[1].includes('\t') ? '\t' : indentMatch[1].length) : 2;
    const mode = process.platform === 'win32' ? 0o600 : fs.statSync(this.path).mode & 0o777;
    return { data: data as Record<string, unknown>, indent, newline: raw.endsWith('\n'), mode };
  }
}
