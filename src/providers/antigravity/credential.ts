import { LockerError } from '../../util/errors.js';

/** An OAuth blob is ~600 bytes; cap imports so a tampered export cannot exhaust memory. */
export const MAX_AGY_CREDENTIAL_BYTES = 256 * 1024;

/** The subset of the keyring JSON that identifies the account and its tokens. */
export interface AgyCredential {
  email?: string;
  authMethod?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Milliseconds since epoch, when the access token expires. */
  expiresAt?: number;
}

/**
 * agy writes a JSON object with `auth_method`, `id_token_email`, and a `token` object
 * holding the OAuth access/refresh tokens. Unknown fields are preserved because the raw
 * bytes, not this parse, are what ai-locker stores and restores.
 */
export function parseAgyCredential(data: Buffer): AgyCredential {
  if (data.length === 0) {
    throw new LockerError(
      'The Antigravity credential in the OS keyring is empty.',
      'E_FORMAT',
      'Run `agy`, sign in with /login, then retry.',
    );
  }
  if (data.length > MAX_AGY_CREDENTIAL_BYTES) {
    throw new LockerError(
      `The Antigravity credential is larger than ${MAX_AGY_CREDENTIAL_BYTES} bytes.`,
      'E_FORMAT',
    );
  }
  const text = data.toString('utf8').replace(/^\uFEFF/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LockerError(
      'The Antigravity credential in the OS keyring is not valid JSON.',
      'E_FORMAT',
      'Run `agy`, sign in with /login again, then retry.',
    );
  }
  const root = asObject(parsed);
  if (!root) {
    throw new LockerError('The Antigravity credential has an unexpected shape.', 'E_FORMAT');
  }
  const token = asObject(root.token) ?? root;
  const accessToken = asText(token.access_token) ?? asText(root.access_token);
  const refreshToken = asText(token.refresh_token) ?? asText(root.refresh_token);
  if (!accessToken && !refreshToken) {
    throw new LockerError(
      'The Antigravity credential does not contain an access or refresh token.',
      'E_FORMAT',
      'Log in again with `agy` and /login.',
    );
  }
  return {
    email: asText(root.id_token_email) ?? asText(root.email) ?? asText(asObject(root.id_token)?.email),
    authMethod: asText(root.auth_method),
    accessToken,
    refreshToken,
    expiresAt: parseExpiry(token.expiry ?? root.expiry),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && !/[\0\r\n]/.test(text) ? text : undefined;
}

function parseExpiry(value: unknown): number | undefined {
  let ms: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = Math.abs(value) >= 1e12 ? value : value * 1000;
  } else if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    if (/^\d+(\.\d+)?$/.test(text)) ms = parseExpiry(Number(text));
    else ms = Date.parse(text);
  }
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.round(ms);
}
