import { run } from '../../util/exec.js';
import type { Identity } from '../Provider.js';
import { cleanKiroEnv } from './env.js';

/**
 * `kiro-cli whoami --format json`. A store with no login reports `{ "account": null }`;
 * a stored login reports its provider even when the token can no longer be resolved, so an
 * missing email means "unconfirmed", not "logged out".
 */
export interface KiroWhoAmi {
  accountType?: string;
  provider?: string;
  email?: string | null;
  account?: unknown;
}

export interface KiroWhoAmiResult {
  whoami: KiroWhoAmi | null;
  loggedIn: boolean;
  error?: string;
  code: number;
}

export interface FetchKiroWhoAmiOptions {
  bin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** The token row as Kiro stores it. Never log or echo these values. */
export interface KiroToken {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  provider?: unknown;
  profile_arn?: unknown;
}

export async function fetchKiroWhoAmi(opts: FetchKiroWhoAmiOptions): Promise<KiroWhoAmiResult> {
  const res = await run(opts.bin, ['whoami', '--format', 'json'], {
    env: cleanKiroEnv(opts.env),
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    return {
      whoami: null,
      loggedIn: false,
      code: res.code,
      error: detail
        ? `kiro-cli whoami exited with code ${res.code}: ${truncate(detail)}`
        : `kiro-cli whoami exited with code ${res.code}`,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const whoami = parsed as KiroWhoAmi;
    return { whoami, loggedIn: Boolean(whoami.accountType || whoami.provider), code: 0 };
  } catch {
    return { whoami: null, loggedIn: false, code: res.code, error: `unexpected output from \`kiro-cli whoami\` (exit ${res.code})` };
  }
}

export function whoAmiEmail(whoami: KiroWhoAmi | null | undefined): string | undefined {
  return typeof whoami?.email === 'string' && whoami.email.trim() ? whoami.email.trim() : undefined;
}

/** Identity from the token row plus whatever whoami could confirm. */
export function tokenIdentity(token: KiroToken, whoami: KiroWhoAmi | null | undefined): Identity {
  const email = whoAmiEmail(whoami);
  const provider =
    typeof whoami?.provider === 'string' ? whoami.provider : typeof token.provider === 'string' ? token.provider : undefined;
  const arn = typeof token.profile_arn === 'string' && token.profile_arn.trim() ? token.profile_arn.trim() : undefined;
  const expiresAt = parseExpiry(token.expires_at);
  return {
    // Keyed on the email when whoami can name the account, otherwise on the profile ARN from the
    // token row. The provider alone is never a key: two social logins from the same IdP would share
    // it, and the core would overwrite one saved profile with the other's rotated refresh token.
    accountKey: (email ? `kiro:email:${email.toLowerCase()}` : undefined) ?? (arn ? `kiro:arn:${arn.toLowerCase()}` : undefined),
    email,
    username: provider,
    plan: whoami?.accountType,
    tokenExpiresAt: expiresAt,
  };
}

/**
 * Which fact a key was derived from. Keys from different sources describe the same account
 * whenever `kiro-cli whoami` cannot reach the IdP, so they must not be compared to each other.
 */
export function kiroKeySource(key: string): string {
  if (key.startsWith('kiro:email:')) return 'email';
  if (key.startsWith('kiro:arn:')) return 'arn';
  return 'other';
}

/**
 * Field names Kiro has been observed using for the same value. Builds that store camelCase,
 * or the row as an array of `{ key, value }` pairs, are folded into these canonical fields.
 * A reported `expiresIn` is a duration rather than a timestamp, so it is deliberately not an alias.
 */
const TOKEN_FIELDS: Record<keyof KiroToken, readonly string[]> = {
  access_token: ['access_token', 'accessToken'],
  refresh_token: ['refresh_token', 'refreshToken'],
  expires_at: ['expires_at', 'expiresAt', 'expiration'],
  provider: ['provider'],
  profile_arn: ['profile_arn', 'profileArn'],
};

export function parseKiroToken(value: unknown): KiroToken {
  if (typeof value !== 'string') return {};
  const fields = flattenTokenFields(value);
  if (!fields) return {};
  const token: Record<string, unknown> = {};
  for (const [canonical, names] of Object.entries(TOKEN_FIELDS)) {
    for (const name of names) {
      if (fields[name] !== undefined) {
        token[canonical] = fields[name];
        break;
      }
    }
  }
  return token as KiroToken;
}

function flattenTokenFields(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const merged: Record<string, unknown> = {};
  let found = false;
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.key === 'string' && 'value' in entry) merged[entry.key] = entry.value;
    else Object.assign(merged, entry);
    found = true;
  }
  return found ? merged : null;
}

/** Accepts epoch seconds, epoch milliseconds, or any date string Node can parse. */
function parseExpiry(value: unknown): number | undefined {
  let raw: number | undefined;
  if (typeof value === 'number') raw = value;
  else if (typeof value === 'string') {
    const asNumber = Number(value);
    raw = Number.isFinite(asNumber) ? asNumber : Date.parse(value);
  }
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return raw < 1e11 ? raw * 1000 : raw;
}

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 400)}...` : oneLine;
}
