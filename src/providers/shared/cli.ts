import type { ExecResult } from '../../util/exec.js';
import type { KeyringAvailability, KeyringBackend } from '../../util/keyring.js';
import { LockerError } from '../../util/errors.js';
import type { DoctorCheck } from '../Provider.js';

/** The `--version` doctor row every CLI-backed provider needs. */
export async function cliDoctorCheck(opts: {
  label: string;
  command: string;
  bin: string | null;
  runVersion: (bin: string) => Promise<ExecResult>;
}): Promise<DoctorCheck> {
  if (!opts.bin) {
    return { name: opts.label, status: 'warn', detail: `\`${opts.command}\` not found on PATH` };
  }
  const version = await opts.runVersion(opts.bin);
  return version.code === 0
    ? { name: opts.label, status: 'ok', detail: `${version.stdout.trim() || 'installed'} at ${opts.bin}` }
    : { name: opts.label, status: 'warn', detail: `\`${opts.bin} --version\` failed` };
}

export async function keyringAvailability(backend: KeyringBackend): Promise<KeyringAvailability> {
  return backend.available();
}

export function keyringDoctorCheck(backend: KeyringBackend, availability: KeyringAvailability): DoctorCheck {
  return {
    name: 'Credential store',
    status: availability.ok ? 'ok' : 'fail',
    detail: `${backend.kind}: ${availability.detail}`,
  };
}

/** Switching is impossible without the keyring, so fail before touching the live store. */
export async function assertKeyringReady(backend: KeyringBackend): Promise<void> {
  const availability = await backend.available();
  if (!availability.ok) {
    throw new LockerError(`No OS credential store available: ${availability.detail}`, 'E_KEYRING');
  }
}
