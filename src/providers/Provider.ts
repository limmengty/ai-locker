/**
 * A Provider knows how one AI CLI stores its login on this machine. ai-locker only ever
 * moves opaque snapshots between the provider's live store and the encrypted vault.
 * Claude Code, Qoder, Copilot, Antigravity and Kiro implement this contract.
 */
export interface Identity {
  /** Stable key for "same account" (survives token rotation). */
  accountKey?: string;
  email?: string;
  /** Login name when the provider has no email (e.g. a GitHub login). */
  username?: string;
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
  username?: string;
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
  /** Host to authenticate against (GitHub Enterprise, for example). */
  host?: string;
}

/** What the CLI is allowed to expose for a provider. */
export interface ProviderCapabilities {
  login: { email: boolean; sso: boolean; console: boolean; host: boolean };
  /** The provider's CLI can run the login itself. */
  automatedLogin: boolean;
  manualLogin: boolean;
  usage: boolean;
  /** Whether a profile captured here can work on another machine. */
  portableExport: boolean;
}

export interface Provider<S = unknown> {
  readonly id: string;
  readonly displayName: string;
  /** Command shown to the user when they need to log in themselves. */
  readonly loginHint: string;
  /** Extra instructions for a login that happens inside the provider's own UI. */
  readonly manualLoginHint?: string;
  readonly capabilities: ProviderCapabilities;
  /** Optional wording for the "quit before switching" error. */
  readonly runningHint?: string;

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

  /** Throw when the environment makes switching ineffective (e.g. a PAT override). */
  preflight?(): Promise<void>;
  /** Check an imported snapshot can work on this machine before storing it. */
  validateSnapshot?(snapshot: S): Promise<{ ok: boolean; reason?: string }>;
}
