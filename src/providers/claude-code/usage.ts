import type { UsageReport, UsageWindow } from '../Provider.js';

/**
 * Undocumented endpoint used by Claude Code's own /usage view. Schema has changed over
 * time, so parsing tolerates both known shapes and silently ignores unknown fields.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export async function fetchUsage(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<UsageReport> {
  let res: Response;
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'ai-locker',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, windows: [], error: `network error: ${(err as Error).message}` };
  }
  if (res.status === 401) return { ok: false, windows: [], error: 'token rejected (401)' };
  if (!res.ok) return { ok: false, windows: [], error: `HTTP ${res.status}` };
  try {
    return { ok: true, windows: parseUsage(await res.json()) };
  } catch {
    return { ok: false, windows: [], error: 'unrecognised response' };
  }
}

export function parseUsage(body: unknown): UsageWindow[] {
  if (!body || typeof body !== 'object') return [];
  const j = body as Record<string, any>;
  const windows: UsageWindow[] = [];

  if (Array.isArray(j.limits)) {
    for (const l of j.limits) {
      if (!l || typeof l !== 'object') continue;
      const scoped = l.scope?.model?.display_name;
      const label =
        l.kind === 'session'
          ? 'Session'
          : l.kind === 'weekly_all'
            ? 'Weekly (all models)'
            : l.kind === 'weekly_scoped'
              ? `Weekly (${scoped ?? 'scoped'})`
              : String(l.kind ?? 'limit');
      windows.push({ label, percent: num(l.percent ?? l.utilization), resetsAt: str(l.resets_at) });
    }
  }

  const legacy: [string, string][] = [
    ['five_hour', '5-hour'],
    ['seven_day', 'Weekly (all models)'],
    ['seven_day_opus', 'Weekly (Opus)'],
    ['seven_day_sonnet', 'Weekly (Sonnet)'],
  ];
  if (windows.length === 0) {
    for (const [key, label] of legacy) {
      const w = j[key];
      if (w && typeof w === 'object' && num(w.utilization) !== null) {
        windows.push({ label, percent: num(w.utilization), resetsAt: str(w.resets_at) });
      }
    }
  }
  return windows;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
