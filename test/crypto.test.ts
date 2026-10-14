import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { defaultKdf, deriveKek, hasArgon2, open, openJson, seal, sealJson, subkey } from '../src/vault/crypto.js';
import { LockerError } from '../src/util/errors.js';

const key = crypto.randomBytes(32);

describe('seal/open', () => {
  it('round-trips', () => {
    const s = seal(key, Buffer.from('hello'), 'aad-1');
    expect(open(key, s, 'aad-1').toString()).toBe('hello');
  });

  it('uses a fresh nonce every time', () => {
    const a = seal(key, Buffer.from('x'), 'a');
    const b = seal(key, Buffer.from('x'), 'a');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects tampered ciphertext', () => {
    const s = seal(key, Buffer.from('secret tokens'), 'aad');
    const ct = Buffer.from(s.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    expect(() => open(key, { ...s, ct: ct.toString('base64') }, 'aad')).toThrow(LockerError);
  });

  it('rejects tampered tag, wrong AAD, and wrong key', () => {
    const s = seal(key, Buffer.from('secret'), 'aad');
    const tag = Buffer.from(s.tag, 'base64');
    tag[0] = (tag[0] ?? 0) ^ 1;
    expect(() => open(key, { ...s, tag: tag.toString('base64') }, 'aad')).toThrow(/tampered/);
    expect(() => open(key, s, 'other-aad')).toThrow(/tampered/);
    expect(() => open(crypto.randomBytes(32), s, 'aad')).toThrow(/tampered/);
  });

  it('round-trips JSON', () => {
    const value = { a: 1, nested: { b: ['c'] } };
    expect(openJson(key, sealJson(key, value, 'j'), 'j')).toEqual(value);
  });
});

describe('subkey', () => {
  it('derives distinct keys per purpose and id, deterministically', () => {
    const a = subkey(key, 'profile', '1');
    expect(subkey(key, 'profile', '1').equals(a)).toBe(true);
    expect(subkey(key, 'profile', '2').equals(a)).toBe(false);
    expect(subkey(key, 'manifest').equals(a)).toBe(false);
  });

  it('matches the RFC 5869 HKDF-SHA256 construction', () => {
    const expected = crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'ai-locker/manifest//v1', 32);
    expect(subkey(key, 'manifest').equals(Buffer.from(expected))).toBe(true);
  });
});

describe('KDF', () => {
  it('scrypt is deterministic for the same salt and differs by passphrase', async () => {
    const params = { name: 'scrypt' as const, N: 2 ** 10, r: 8, p: 1, salt: 'c2FsdHNhbHRzYWx0c2FsdA==' };
    const a = await deriveKek('passphrase one', params);
    expect((await deriveKek('passphrase one', params)).equals(a)).toBe(true);
    expect((await deriveKek('passphrase two', params)).equals(a)).toBe(false);
    expect(a).toHaveLength(32);
  });

  it('normalises Unicode so composed and decomposed input derive the same key', async () => {
    const params = { name: 'scrypt' as const, N: 2 ** 10, r: 8, p: 1, salt: 'c2FsdHNhbHRzYWx0c2FsdA==' };
    const composed = await deriveKek('café passphrase', params);
    const decomposed = await deriveKek('café passphrase', params);
    expect(composed.equals(decomposed)).toBe(true);
  });

  it('defaults to Argon2id when available, otherwise scrypt', () => {
    expect(defaultKdf().name).toBe(hasArgon2 ? 'argon2id' : 'scrypt');
    expect(defaultKdf(true).name).toBe('scrypt');
  });

  it.runIf(hasArgon2)('derives with production Argon2id parameters', async () => {
    const params = defaultKdf();
    expect(params).toMatchObject({ name: 'argon2id', memoryKiB: 65536, passes: 3, parallelism: 1 });
    const a = await deriveKek('passphrase', params);
    expect((await deriveKek('passphrase', params)).equals(a)).toBe(true);
  });
});
