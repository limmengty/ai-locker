import fs from 'node:fs';
import { LockerError } from '../../util/errors.js';
import type { KiroEnv } from './env.js';

/** Row that holds the Kiro login: access/refresh token, expiry, provider and profile ARN. */
export const KIRO_TOKEN_KEY = 'kirocli:social:token';
/** Identity Center / CodeWhisperer profile row that belongs to the same login. */
export const KIRO_PROFILE_KEY = 'api.codewhisperer.profile';
/** A Kiro token row is under 1 KiB; cap imports so a tampered export cannot exhaust memory. */
export const MAX_KIRO_SNAPSHOT_BYTES = 256 * 1024;

interface SqliteStmt {
  get(...args: unknown[]): Record<string, unknown> | undefined;
  run(...args: unknown[]): unknown;
}

interface SqliteDb {
  prepare(sql: string): SqliteStmt;
  exec(sql: string): void;
  close(): void;
}

/** The parts of the Kiro database a switch needs; tests substitute an in-memory version. */
export interface KiroStoreLike {
  readonly kind: string;
  readonly location: string;
  exists(): boolean;
  readToken(): Promise<string | null>;
  readProfile(): Promise<string | null>;
  writeRows(token: string, profile: string | null): Promise<void>;
  clearRows(): Promise<void>;
}

/**
 * Kiro keeps its login in a SQLite file next to the binary, so reads and writes go through
 * the built-in driver. Only the two rows a switch needs are touched; telemetry rows stay alone.
 */
export class KiroStore implements KiroStoreLike {
  readonly kind = 'sqlite';
  constructor(readonly env: KiroEnv) {}

  get location(): string {
    return this.env.dbFile;
  }

  exists(): boolean {
    return fs.existsSync(this.env.dbFile);
  }

  async readToken(): Promise<string | null> {
    return this.readRow('auth_kv', KIRO_TOKEN_KEY);
  }

  async readProfile(): Promise<string | null> {
    return this.readRow('state', KIRO_PROFILE_KEY);
  }

  async writeRows(token: string, profile: string | null): Promise<void> {
    const db = await this.openForWrite();
    try {
      // Both rows belong to one login, so they change together or not at all: a new token beside
      // a stale or deleted profile row is a login Kiro cannot use.
      inTransaction(db, () => {
        db.prepare('insert or replace into auth_kv(key, value) values(?, ?)').run(KIRO_TOKEN_KEY, token);
        if (profile === null) db.prepare('delete from state where key = ?').run(KIRO_PROFILE_KEY);
        else db.prepare('insert or replace into state(key, value) values(?, ?)').run(KIRO_PROFILE_KEY, profile);
      });
    } catch (err) {
      throw this.storeError('write', err);
    } finally {
      db.close();
    }
  }

  async clearRows(): Promise<void> {
    if (!this.exists()) return;
    const db = await openDb(this.env.dbFile, false);
    try {
      inTransaction(db, () => {
        // Skip a table Kiro has not created yet rather than failing: with no login tables the
        // store already holds no login. Silently returning after a failed delete would report a
        // logout that never happened.
        if (hasTable(db, 'auth_kv')) db.prepare('delete from auth_kv where key = ?').run(KIRO_TOKEN_KEY);
        if (hasTable(db, 'state')) db.prepare('delete from state where key = ?').run(KIRO_PROFILE_KEY);
      });
    } catch (err) {
      throw this.storeError('clear', err);
    } finally {
      db.close();
    }
  }

  private async readRow(table: 'auth_kv' | 'state', key: string): Promise<string | null> {
    if (!this.exists()) return null;
    const db = await openDb(this.env.dbFile, true);
    try {
      const row = db.prepare(`select value from ${table} where key = ?`).get(key);
      const value = row?.value;
      if (value === undefined || value === null) return null;
      return typeof value === 'string' ? value : Buffer.from(value as Uint8Array).toString('utf8');
    } catch (err) {
      if (isMissingTable(err)) return null;
      throw this.storeError('read', err);
    } finally {
      db.close();
    }
  }

  private async openForWrite(): Promise<SqliteDb> {
    if (!this.exists()) {
      throw new LockerError(
        'Kiro has no data store on this machine yet, so a saved login cannot be restored.',
        'E_KIRO_STORE',
        'Run `kiro-cli login` once to create it, then add the account again.',
      );
    }
    return openDb(this.env.dbFile, false);
  }

  private storeError(op: string, err: unknown): LockerError {
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingTable(err)) {
      return new LockerError(
        `The Kiro database at ${this.location} has no login tables.`,
        'E_KIRO_STORE',
        'Run `kiro-cli login` once to let Kiro create its store, then retry.',
      );
    }
    return new LockerError(`Could not ${op} the Kiro login in ${this.location}.`, 'E_KIRO_STORE', message);
  }
}

/**
 * Built through a variable because the bundler rewrites a literal `import('node:sqlite')`
 * into `import("sqlite")` for its node20 target, and that module does not exist.
 */
function sqliteModuleName(): string {
  return 'node:' + 'sqlite';
}

async function openDb(file: string, readOnly: boolean): Promise<SqliteDb> {
  let mod: typeof import('node:sqlite');
  try {
    mod = await import(sqliteModuleName());
  } catch {
    throw new LockerError(
      'The Kiro provider needs the built-in `node:sqlite` module.',
      'E_KIRO_NODE',
      `Kiro support requires Node.js 22.13 or newer; this process is ${process.version}.`,
    );
  }
  try {
    const db = new mod.DatabaseSync(file, { readOnly }) as unknown as SqliteDb;
    if (!readOnly) db.exec('pragma busy_timeout = 5000');
    return db;
  } catch (err) {
    throw new LockerError(
      `Could not open the Kiro database at ${file}.`,
      'E_KIRO_STORE',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function hasTable(db: SqliteDb, name: string): boolean {
  return db.prepare('select 1 as found from sqlite_master where type = ? and name = ?').get('table', name) !== undefined;
}

/** Run both row statements inside one transaction so a failure cannot split a login across rows. */
function inTransaction(db: SqliteDb, body: () => void): void {
  db.exec('begin immediate');
  try {
    body();
  } catch (err) {
    try {
      db.exec('rollback');
    } catch {
      /* the transaction is already gone; the original error explains the failure */
    }
    throw err;
  }
  db.exec('commit');
}

function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}
