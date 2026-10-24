import os from 'node:os';
import path from 'node:path';

/** Root of ai-locker's own state. Override with AI_LOCKER_HOME (used by tests). */
export function lockerHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_LOCKER_HOME || path.join(os.homedir(), '.ai-locker');
}

export function lockerPaths(home = lockerHome()) {
  return {
    home,
    vault: path.join(home, 'vault.json'),
    profilesDir: path.join(home, 'profiles'),
    profile: (id: string) => path.join(home, 'profiles', `${id}.enc`),
    /** Pre-provider-scoped rollback file, still read so an upgrade can finish an interrupted op. */
    rollback: path.join(home, 'rollback.enc'),
    rollbackFor: (provider: string) => path.join(home, `rollback-${provider}.enc`),
    osUnlockBlob: path.join(home, 'os-unlock.bin'),
    audit: path.join(home, 'audit.log'),
    lock: path.join(home, '.lock'),
  };
}

export type LockerPaths = ReturnType<typeof lockerPaths>;
