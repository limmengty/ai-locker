/**
 * A Provider knows how one AI CLI stores its login on this machine. ai-locker only ever
 * moves opaque snapshots between the provider's live store and the encrypted vault.
 * Claude Code is the only implementation today; others (Codex, Gemini CLI, ...) plug in here.
 */
export interface Identity {
  /** Stable key for "same account" (survives token rotation). */
  accountKey?: string;
  email?: string;
  organization?: string;
  plan?: string;
  tokenExpiresAt?: number;
  refreshExpiresAt?: number;
}

export interface StoreDescription {
  kind: string;
  location: string;
}

export interface RunningProcess {
  pid: number;
  name: string;
}

export interface VerifyResult {
  ok: boolean;
  skipped?: boolean;
  detail: string;
  email?: string;
}

export interface UsageWindow {
  label: string;
  percent: number | null;
  resetsAt: string | null;
}

export interface UsageReport {
  ok: boolean;
  windows: UsageWindow[];
  error?: string;
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
}

export interface LoginOptions {
  email?: string;
  sso?: boolean;
  console?: boolean;
}

export interface Provider<S = unknown> {
  readonly id: string;
  readonly displayName: string;

  describeStore(): StoreDescription;
  /** Raw contents of the live store, or null if empty. May contain no login (see hasLogin). */
  readLive(): Promise<S | null>;
  writeLive(snapshot: S): Promise<void>;
  clearLive(): Promise<void>;

  hasLogin(snapshot: S): boolean;
  fingerprint(snapshot: S): string;
  identity(snapshot: S): Identity;

  runningProcesses(): Promise<RunningProcess[]>;
  verifyLive(expected?: Identity): Promise<VerifyResult>;
  login(opts: LoginOptions): Promise<number>;
  usage?(snapshot: S): Promise<UsageReport>;
  doctor(): Promise<DoctorCheck[]>;
}
