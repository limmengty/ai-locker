import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { editJsoncObject, parseJsonc } from '../src/util/jsonc.js';
import { keyringBackend } from '../src/util/keyring.js';

describe('JSONC parsing', () => {
  it('accepts comments and trailing commas', () => {
    const text = `{
      // leading comment
      "a": 1,
      "b": [1, 2,], /* inline */
      "c": { "d": "// not a comment" },
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2], c: { d: '// not a comment' } });
  });

  it('rejects trailing garbage', () => {
    expect(() => parseJsonc('{} x')).toThrow(SyntaxError);
  });
});

describe('JSONC editing', () => {
  it('replaces a value and preserves comments and other formatting', () => {
    const text = `{
  // managed automatically
  "lastLoggedInUser": { "host": "https://github.com", "login": "alice" },
  "loggedInUsers": [ { "host": "https://github.com", "login": "alice", "kind": "githubDotCom" } ],
  "theme": "dark"
}
`;
    const out = editJsoncObject(text, {
      lastLoggedInUser: { host: 'https://github.com', login: 'bob' },
      loggedInUsers: [
        { host: 'https://github.com', login: 'alice', kind: 'githubDotCom' },
        { host: 'https://github.com', login: 'bob', kind: 'githubDotCom' },
      ],
    });
    expect(out).toContain('// managed automatically');
    expect(out).toContain('"theme": "dark"');
    expect(parseJsonc(out)).toEqual({
      lastLoggedInUser: { host: 'https://github.com', login: 'bob' },
      loggedInUsers: [
        { host: 'https://github.com', login: 'alice', kind: 'githubDotCom' },
        { host: 'https://github.com', login: 'bob', kind: 'githubDotCom' },
      ],
      theme: 'dark',
    });
  });

  it('adds a missing key and deletes an existing one', () => {
    const added = editJsoncObject('{\n  "a": 1\n}\n', { b: { c: true } });
    expect(parseJsonc(added)).toEqual({ a: 1, b: { c: true } });

    const deleted = editJsoncObject(added, { a: undefined });
    expect(parseJsonc(deleted)).toEqual({ b: { c: true } });
    expect(deleted).not.toContain('"a"');
  });

  it('handles an empty object and a single key', () => {
    const empty = editJsoncObject('{}', { a: 1 });
    expect(empty).toBe('{\n  "a": 1\n}');
    expect(editJsoncObject('{"a":1}', { a: undefined })).toBe('{}');
  });

  it('does not double a trailing comma when appending', () => {
    const out = editJsoncObject('{\n  "a": 1,\n}\n', { b: 2 });
    expect(out).not.toContain(',,');
    expect(parseJsonc(out)).toEqual({ a: 1, b: 2 });
  });

  it('appends outside a trailing line comment', () => {
    const out = editJsoncObject('{\n  "a": 1, // keep me\n}\n', { b: 2 });
    expect(out).toContain('// keep me');
    expect(parseJsonc(out)).toEqual({ a: 1, b: 2 });
  });

  it('removes a trailing comma together with the only key', () => {
    const out = editJsoncObject('{ "a": 1, }', { a: undefined });
    expect(parseJsonc(out)).toEqual({});
    expect(out).not.toContain(',');
  });
});

describe('keyring argument safety', () => {
  it('refuses macOS values that could break out of `security -i`', async () => {
    const backend = keyringBackend('darwin');
    await expect(
      backend.write({ service: 'copilot-cli', account: 'x" -w hacked', secret: Buffer.from('t') }),
    ).rejects.toMatchObject({ code: 'E_KEYRING' });
    await expect(
      backend.write({ service: 'copilot-cli', account: 'x\\y', secret: Buffer.from('t') }),
    ).rejects.toMatchObject({ code: 'E_KEYRING' });
  });
});

describe.runIf(process.platform === 'win32')('Windows Credential Manager backend', () => {
  const backend = keyringBackend('win32');
  const service = `ai-locker-test-${crypto.randomBytes(4).toString('hex')}`;
  const account = `test-${crypto.randomBytes(4).toString('hex')}`;
  const ref = { service, account, windowsTarget: `${account}.${service}` };

  it('round-trips a binary secret with persistence and comment', async () => {
    expect(await backend.available()).toMatchObject({ ok: true });
    const secret = Buffer.from(`token-${crypto.randomBytes(8).toString('hex')}`, 'utf16le');
    await backend.write({ ...ref, secret, comment: 'ai-locker test', persist: 3 });
    try {
      const got = await backend.read(ref);
      expect(got?.secret.equals(secret)).toBe(true);
      expect(got?.persist).toBe(3);
      expect(got?.comment).toBe('ai-locker test');
    } finally {
      expect(await backend.delete(ref)).toBe(true);
    }
    expect(await backend.read(ref)).toBeNull();
    expect(await backend.delete(ref)).toBe(false);
  }, 120_000);
});
