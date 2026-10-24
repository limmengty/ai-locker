import fs from 'node:fs';
import { atomicWrite, readIfExists } from '../../vault/atomicWrite.js';
import { LockerError } from '../../util/errors.js';
import { editJsoncObject, parseJsonc } from '../../util/jsonc.js';
import type { CopilotEnv } from './env.js';

/** Copilot's config.json is JSONC with a leading "managed automatically" comment. */
export interface CopilotConfig {
  [key: string]: unknown;
}

export interface CopilotUser {
  host: string;
  login: string;
  kind?: string;
}

interface RosterRecord extends CopilotUser {
  raw: Record<string, unknown>;
}

export function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, '');
}

export function sameUser(a: CopilotUser, b: CopilotUser): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.login.toLowerCase() === b.login.toLowerCase();
}

export function parseCopilotConfig(text: string, file = 'config.json'): CopilotConfig {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (err) {
    throw new LockerError(
      `Copilot's ${file} is not valid JSONC: ${(err as Error).message}`,
      'E_COPILOT_CONFIG',
      'Fix the file (or let Copilot recreate it) and retry.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LockerError(`Copilot's ${file} is not a JSON object.`, 'E_COPILOT_CONFIG');
  }
  return value as CopilotConfig;
}

export async function readCopilotConfig(env: CopilotEnv): Promise<{ text: string | null; config: CopilotConfig }> {
  const text = await readIfExists(env.configFile);
  if (text === null || !text.trim()) return { text: null, config: {} };
  return { text, config: parseCopilotConfig(text, env.configFile) };
}

export function readActiveUser(config: CopilotConfig): CopilotUser | null {
  const raw = config.lastLoggedInUser;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const host = typeof r.host === 'string' ? normalizeHost(r.host) : '';
  const login = typeof r.login === 'string' ? r.login.trim() : '';
  if (!host || !login) return null;
  return { host, login, kind: typeof r.kind === 'string' ? r.kind : undefined };
}

export function readRoster(config: CopilotConfig): CopilotUser[] {
  return readRosterRecords(config).map((r) => ({ host: r.host, login: r.login, kind: r.kind }));
}

/** Add (or refresh) the active account in the roster and point lastLoggedInUser at it. */
export function withActiveUser(text: string | null, user: CopilotUser): string {
  if (text === null) {
    const entry: Record<string, unknown> = { host: user.host, login: user.login };
    const kind = user.kind ?? defaultKind(user.host);
    if (kind) entry.kind = kind;
    return (
      JSON.stringify({ loggedInUsers: [entry], lastLoggedInUser: { host: user.host, login: user.login } }, null, 2) + '\n'
    );
  }
  const config = parseCopilotConfig(text);
  const roster = readRosterRecords(config);
  const index = roster.findIndex((r) => sameUser(r, user));
  if (index >= 0) {
    const raw: Record<string, unknown> = { ...roster[index]!.raw, host: user.host, login: user.login };
    if (user.kind) raw.kind = user.kind;
    roster[index] = { host: user.host, login: user.login, kind: user.kind ?? roster[index]!.kind, raw };
  } else {
    const entry: Record<string, unknown> = { host: user.host, login: user.login };
    const kind = user.kind ?? defaultKind(user.host);
    if (kind) entry.kind = kind;
    roster.push({ host: user.host, login: user.login, kind, raw: entry });
  }
  return editJsoncObject(text, {
    loggedInUsers: roster.map((r) => r.raw),
    lastLoggedInUser: { host: user.host, login: user.login },
  });
}

/** Remove the active account from the roster and clear lastLoggedInUser. */
export function withoutActiveUser(text: string, active: CopilotUser): string {
  const config = parseCopilotConfig(text);
  const updates: Record<string, unknown> = { lastLoggedInUser: undefined };
  if (Array.isArray(config.loggedInUsers)) {
    updates.loggedInUsers = readRosterRecords(config)
      .filter((r) => !sameUser(r, active))
      .map((r) => r.raw);
  }
  return editJsoncObject(text, updates);
}

export async function writeCopilotConfig(env: CopilotEnv, text: string): Promise<void> {
  await atomicWrite(env.configFile, text, 0o600);
}

/** Plan metadata from Copilot's disposable user cache. Never contains a credential. */
export function readCachedIdentity(file: string, login: string): { plan?: string; sku?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let cache: unknown;
  try {
    cache = parseJsonc(text);
  } catch {
    return {};
  }
  const entries = (cache as { copilotUserCache?: unknown })?.copilotUserCache;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
  let best: Record<string, unknown> | null = null;
  let bestTime = -1;
  for (const value of Object.values(entries as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const response = entry.response;
    if (!response || typeof response !== 'object') continue;
    const r = response as Record<string, unknown>;
    if (typeof r.login !== 'string' || r.login.toLowerCase() !== login.toLowerCase()) continue;
    const at = typeof entry.retrievedAt === 'string' ? Date.parse(entry.retrievedAt) : NaN;
    const time = Number.isFinite(at) ? at : 0;
    if (time > bestTime) {
      bestTime = time;
      best = r;
    }
  }
  if (!best) return {};
  const plan = textOf(best.copilot_plan) ?? textOf(best.access_type_sku);
  const sku = textOf(best.access_type_sku);
  return { plan, sku };
}

function readRosterRecords(config: CopilotConfig): RosterRecord[] {
  const list = config.loggedInUsers;
  if (!Array.isArray(list)) return [];
  const out: RosterRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const host = typeof raw.host === 'string' ? normalizeHost(raw.host) : '';
    const login = typeof raw.login === 'string' ? raw.login.trim() : '';
    if (!host || !login) continue;
    out.push({ host, login, kind: typeof raw.kind === 'string' ? raw.kind : undefined, raw });
  }
  return out;
}

function defaultKind(host: string): string | undefined {
  return host.toLowerCase() === 'https://github.com' ? 'githubDotCom' : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
