import { run } from '../../util/exec.js';
import type { Identity } from '../Provider.js';
import { cleanQoderEnv } from './env.js';

/** `qodercli status -o json` as of Qoder CLI 1.1.78. Fields vary by account type. */
export interface QoderStatus {
  logged_in?: boolean;
  version?: string;
  allow_byok?: number;
  auth_source?: string;
  account_type?: string;
  login_method?: string;
  username?: string;
  email?: string;
  avatar_url?: string;
  user_type?: string;
  principal_id?: string;
  org_id?: string;
  organization_name?: string;
  auth_error_reason?: string;
  auth_error_message?: string;
}

export interface QoderStatusResult {
  status: QoderStatus | null;
  error?: string;
  code: number;
}

export interface FetchQoderStatusOptions {
  bin: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function fetchQoderStatus(opts: FetchQoderStatusOptions): Promise<QoderStatusResult> {
  const res = await run(opts.bin, ['--config-dir', opts.configDir, 'status', '-o', 'json'], {
    env: cleanQoderEnv(opts.env),
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    return {
      status: null,
      code: res.code,
      error: detail
        ? `qodercli status exited with code ${res.code}: ${truncate(detail)}`
        : `qodercli status exited with code ${res.code}`,
    };
  }
  try {
    const status = JSON.parse(res.stdout) as unknown;
    if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('not an object');
    return { status: status as QoderStatus, code: 0 };
  } catch {
    return {
      status: null,
      code: res.code,
      error: `unexpected output from \`qodercli status\` (exit ${res.code})`,
    };
  }
}

/** Identity derived from status, never from the opaque credential blob. */
export function statusToIdentity(status: QoderStatus | null | undefined): Identity {
  if (!status?.logged_in) return {};
  const email = typeof status.email === 'string' && status.email.trim() ? status.email.trim() : undefined;
  const uid = /\/users\/([0-9a-fA-F-]{8,})\//.exec(status.avatar_url ?? '')?.[1]?.toLowerCase();
  const serviceAccount =
    status.account_type === 'service_account' && status.org_id && status.principal_id
      ? `qoder:sa:${status.org_id}:${status.principal_id}`
      : undefined;
  return {
    accountKey:
      serviceAccount ??
      (uid ? `qoder:uid:${uid}` : undefined) ??
      (email ? `qoder:email:${email.toLowerCase()}` : undefined),
    email,
    organization: status.org_id ?? status.organization_name,
    plan: status.user_type ?? status.account_type,
  };
}

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 400)}...` : oneLine;
}
