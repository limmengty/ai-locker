import crypto from 'node:crypto';
import { LockerError } from '../util/errors.js';

/**
 * Crypto primitives for the vault. Everything here is Node built-ins only.
 *
 *   passphrase --Argon2id/scrypt--> KEK --AES-256-GCM--> wraps VDK (random 32 bytes)
 *   VDK --HKDF-SHA256(info=purpose/id)--> per-file key --AES-256-GCM--> file contents
 */

export type KdfParams =
  | { name: 'argon2id'; memoryKiB: number; passes: number; parallelism: number; salt: string }
  | { name: 'scrypt'; N: number; r: number; p: number; salt: string };

export interface Sealed {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
  tag: string;
}

const KEY_LEN = 32;
const IV_LEN = 12;

type Argon2Fn = (
  algorithm: 'argon2id',
  params: {
    message: Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
  cb: (err: Error | null, key: Buffer) => void,
) => void;

const argon2 = (crypto as unknown as { argon2?: Argon2Fn }).argon2;

/** Node >= 24.7 ships Argon2 in core; older runtimes fall back to scrypt. */
export const hasArgon2 = typeof argon2 === 'function';

/** OWASP-aligned defaults: Argon2id m=64 MiB, t=3, p=1; scrypt N=2^17, r=8, p=1. */
export function defaultKdf(preferScrypt = false): KdfParams {
  const salt = crypto.randomBytes(16).toString('base64');
  if (hasArgon2 && !preferScrypt) {
    return { name: 'argon2id', memoryKiB: 64 * 1024, passes: 3, parallelism: 1, salt };
  }
  return { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, salt };
}

/**
 * KDF parameters come from files (vault.json, export bundles) that may be attacker-supplied.
 * Cap them so a crafted file can't exhaust memory or CPU before the passphrase is checked.
 */
export function assertKdfParams(params: KdfParams): void {
  const bad = (what: string) => {
    throw new LockerError(`Refusing unsafe key-derivation parameters (${what}).`, 'E_FORMAT');
  };
  if (!params || typeof params.salt !== 'string' || Buffer.from(params.salt, 'base64').length < 8) bad('salt');
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (params.name === 'argon2id') {
    if (!int(params.memoryKiB, 8, 1024 * 1024)) bad('memory');
    if (!int(params.passes, 1, 10)) bad('passes');
    if (!int(params.parallelism, 1, 16)) bad('parallelism');
  } else if (params.name === 'scrypt') {
    if (!int(params.N, 2, 2 ** 20) || (params.N & (params.N - 1)) !== 0) bad('N');
    if (!int(params.r, 1, 16)) bad('r');
    if (!int(params.p, 1, 4)) bad('p');
  } else {
    bad('algorithm');
  }
}

export async function deriveKek(passphrase: string, params: KdfParams): Promise<Buffer> {
  assertKdfParams(params);
  const message = Buffer.from(passphrase.normalize('NFC'), 'utf8');
  const salt = Buffer.from(params.salt, 'base64');
  try {
    if (params.name === 'argon2id') {
      if (!argon2) {
        throw new LockerError(
          'This vault uses Argon2id, which needs Node.js 24.7 or newer.',
          'E_KDF_UNSUPPORTED',
          'Upgrade Node.js, or open the vault on a machine with a newer Node.js.',
        );
      }
      return await new Promise<Buffer>((resolve, reject) =>
        argon2(
          'argon2id',
          {
            message,
            nonce: salt,
            parallelism: params.parallelism,
            tagLength: KEY_LEN,
            memory: params.memoryKiB,
            passes: params.passes,
          },
          (err, key) => (err ? reject(err) : resolve(key)),
        ),
      );
    }
    const maxmem = 128 * params.N * params.r * 2;
    return await new Promise<Buffer>((resolve, reject) =>
      crypto.scrypt(message, salt, KEY_LEN, { N: params.N, r: params.r, p: params.p, maxmem }, (err, key) =>
        err ? reject(err) : resolve(key),
      ),
    );
  } finally {
    message.fill(0);
  }
}

/** Derive an independent key for one purpose so no two files share a key. */
export function subkey(vdk: Buffer, purpose: string, id = ''): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', vdk, Buffer.alloc(0), `ai-locker/${purpose}/${id}/v1`, KEY_LEN));
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  if (!sealed || sealed.v !== 1 || sealed.alg !== 'A256GCM') {
    throw new LockerError('Unsupported or corrupt encrypted record.', 'E_FORMAT');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
  } catch {
    throw new LockerError('Decryption failed: wrong key or the data was tampered with.', 'E_DECRYPT');
  }
}

export function sealJson(key: Buffer, value: unknown, aad: string): Sealed {
  const buf = Buffer.from(JSON.stringify(value), 'utf8');
  try {
    return seal(key, buf, aad);
  } finally {
    buf.fill(0);
  }
}

export function openJson<T>(key: Buffer, sealed: Sealed, aad: string): T {
  const buf = open(key, sealed, aad);
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } finally {
    buf.fill(0);
  }
}

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
