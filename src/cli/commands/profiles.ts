import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { confirm, input } from '@inquirer/prompts';
import { LockerError } from '../../util/errors.js';
import { c, emit, info, note, relTime, warn } from '../../util/output.js';
import { atomicWrite } from '../../vault/atomicWrite.js';
import { checkPassphrase, type ProfileMeta } from '../../vault/vault.js';
import { addFromLive, addViaLogin, captureSummary } from '../../core/switchService.js';
import { assertNameFree, describeProfile, requireProfile, validateName } from '../../core/profiles.js';
import { exportProfiles, importProfiles } from '../../core/transfer.js';
import { getProvider } from '../../providers/index.js';
import { validateLoginEmail } from '../../providers/claude-code/index.js';
import { isInteractive, livePolicy, promptPassphrase, withVault, type GlobalOpts, type LivePolicyFlags } from '../context.js';

interface AddFlags extends LivePolicyFlags {
  fromLive?: boolean;
  manual?: boolean;
  email?: string;
  sso?: boolean;
  console?: boolean;
  host?: string;
  force?: boolean;
  verify: boolean;
}

export function publicMeta(p: ProfileMeta, activeId: string | null | undefined) {
  return {
    id: p.id,
    name: p.name,
    provider: p.provider,
    email: p.email ?? null,
    username: p.username ?? null,
    organization: p.organization ?? null,
    plan: p.plan ?? null,
    active: p.id === activeId,
    tokenExpiresAt: p.tokenExpiresAt ?? null,
    refreshExpiresAt: p.refreshExpiresAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastUsedAt: p.lastUsedAt ?? null,
  };
}

export function registerProfiles(program: Command): void {
  program
    .command('add <name>')
    .description('save an account: log in to a new one, or --from-live to save the current login')
    .option('--from-live', 'save the account the provider is logged in with right now')
    .option('--manual', 'do not launch the login; wait while you run it yourself')
    .option('--email <email>', 'pre-fill the login email (providers that support it)')
    .option('--sso', 'force SSO login (providers that support it)')
    .option('--console', 'log in with a Console/billing account (providers that support it)')
    .option('--host <host>', 'authenticate against a specific host (providers that support it)')
    .option('--save-live-as <name>', 'if the current login is not saved yet, save it under this name first')
    .option('--discard-live', 'if the current login is not saved yet, drop it')
    .option('--force', 'skip the "provider is running" check')
    .option('--no-verify', 'skip the provider status verification')
    .action(async (name: string, flags: AddFlags, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      validateName(name);
      await withVault(g, async (ctx) => {
        const { provider } = ctx;
        if (flags.email && !provider.capabilities.login.email) {
          throw new LockerError(`${provider.displayName} login does not accept --email.`, 'E_ARGS');
        }
        if (flags.sso && !provider.capabilities.login.sso) {
          throw new LockerError(`${provider.displayName} login does not accept --sso.`, 'E_ARGS');
        }
        if (flags.console && !provider.capabilities.login.console) {
          throw new LockerError(`${provider.displayName} login does not accept --console.`, 'E_ARGS');
        }
        if (flags.host && !provider.capabilities.login.host) {
          throw new LockerError(`${provider.displayName} login does not accept --host.`, 'E_ARGS');
        }
        if (flags.email) validateLoginEmail(flags.email);
        if (flags.fromLive) {
          const meta = await addFromLive(ctx, name);
          emit(g, { profile: publicMeta(meta, meta.id) }, () =>
            info(c.green('✔ ') + `Saved ${describeProfile(meta)}. It is the active profile.`),
          );
          return;
        }
        const mustBeManual = flags.manual || !provider.capabilities.automatedLogin;
        const manual = mustBeManual
          ? async () => {
              if (!isInteractive()) {
                throw new LockerError(
                  `${provider.displayName} needs a manual login step, which needs an interactive terminal.`,
                  'E_ARGS',
                );
              }
              if (!provider.capabilities.manualLogin) {
                throw new LockerError(`${provider.displayName} has no manual login step.`, 'E_ARGS');
              }
              note(`\n${provider.displayName} is now logged out. In another terminal run:\n\n    ${c.cyan(provider.loginHint)}\n`);
              if (provider.manualLoginHint) note(provider.manualLoginHint + '\n');
              await input({ message: 'Press Enter once the login has finished' });
            }
          : undefined;
        if (!manual) {
          note(c.dim(`Starting \`${provider.loginHint}\`. Sign in with the account to save as `) + c.bold(name));
          if (provider.manualLoginHint) note(c.dim(provider.manualLoginHint));
        }
        const res = await addViaLogin(ctx, name, {
          ...livePolicy(flags),
          force: flags.force,
          verify: flags.verify,
          manual,
          login: { email: flags.email, sso: flags.sso, console: flags.console, host: flags.host },
        });
        const pre = captureSummary(res.capture);
        emit(g, { profile: publicMeta(res.profile, res.profile.id), duplicate: Boolean(res.duplicateOf) }, () => {
          if (pre) info(c.dim(pre));
          if (res.duplicateOf) {
            info(c.yellow('! ') + `That account is already saved as "${res.duplicateOf.name}"; refreshed it and made it active.`);
          } else {
            info(c.green('✔ ') + `Saved ${describeProfile(res.profile)}. It is the active profile.`);
          }
          if (res.verify?.skipped) warn(res.verify.detail);
        });
      });
    });

  program
    .command('list')
    .alias('ls')
    .description('list saved profiles')
    .action(async (_opts, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      await withVault(g, async ({ vault, provider }) => {
        const activeId = vault.manifest.active[provider.id];
        const profiles = vault.manifest.profiles.filter((p) => p.provider === provider.id);
        emit(g, { profiles: profiles.map((p) => publicMeta(p, activeId)) }, () => {
          if (profiles.length === 0) {
            info('No profiles yet. Run `ai-locker add <name> --from-live` or `ai-locker add <name>`.');
            return;
          }
          const rows = profiles.map((p) => [
            p.id === activeId ? c.green('*') : ' ',
            p.name,
            p.email ?? p.username ?? '-',
            p.plan ?? '-',
            p.lastUsedAt ? relTime(Date.parse(p.lastUsedAt)) : 'never',
            p.refreshExpiresAt ? relTime(p.refreshExpiresAt) : '-',
          ]);
          const header = [' ', 'NAME', 'ACCOUNT', 'PLAN', 'LAST USED', 'LOGIN EXPIRES'];
          printTable([header.map((h) => c.dim(h)), ...rows], header);
          if (!activeId) info(c.dim('\nNo profile is active (vault locked or live login unknown).'));
        });
      });
    });

  program
    .command('rename <profile> <newName>')
    .description('rename a profile')
    .action(async (ref: string, newName: string, _opts, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      await withVault(g, async ({ vault, provider }) => {
        const p = requireProfile(vault.manifest, provider.id, ref);
        if (p.name.toLowerCase() !== newName.toLowerCase()) assertNameFree(vault.manifest, provider.id, newName);
        else validateName(newName);
        const old = p.name;
        p.name = newName;
        p.updatedAt = new Date().toISOString();
        await vault.saveManifest();
        emit(g, { renamed: { from: old, to: newName } }, () => info(c.green('✔ ') + `Renamed ${old} → ${newName}.`));
      });
    });

  program
    .command('remove <profile>')
    .alias('rm')
    .description('delete a saved profile from the vault (does not log the provider out)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (ref: string, opts: { yes?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      await withVault(g, async ({ vault, provider }) => {
        const p = requireProfile(vault.manifest, provider.id, ref);
        if (!opts.yes) {
          if (!isInteractive()) throw new LockerError('Refusing to delete without --yes.', 'E_ARGS');
          const ok = await confirm({ message: `Delete ${describeProfile(p)} from the vault?`, default: false });
          if (!ok) return;
        }
        const wasActive = vault.manifest.active[provider.id] === p.id;
        vault.manifest.profiles = vault.manifest.profiles.filter((x) => x.id !== p.id);
        if (wasActive) vault.manifest.active[provider.id] = null;
        if (vault.manifest.lastActive[provider.id] === p.id) vault.manifest.lastActive[provider.id] = null;
        await vault.saveManifest();
        await vault.deleteProfile(p.id);
        await vault.audit(`remove ${provider.id} ${p.id}`);
        emit(g, { removed: p.name, wasActive }, () => {
          info(c.green('✔ ') + `Removed ${p.name}.`);
          if (wasActive) info(c.dim(`It was active, so ${provider.displayName} is still logged in with it until you switch or lock.`));
        });
      });
    });

  program
    .command('export <file>')
    .description('write selected profiles to a portable file encrypted with a separate passphrase')
    .option('-p, --profile <names...>', 'profiles to export (default: all)')
    .action(async (file: string, opts: { profile?: string[] }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const target = path.resolve(file);
      if (fs.existsSync(target)) throw new LockerError(`${target} already exists.`, 'E_EXISTS');
      await withVault(g, async ({ vault, provider }) => {
        const selected = opts.profile?.length
          ? opts.profile.map((r) => requireProfile(vault.manifest, provider.id, r))
          : vault.manifest.profiles.filter((p) => p.provider === provider.id);
        if (selected.length === 0) throw new LockerError('Nothing to export.', 'E_EMPTY');
        const pass = await exportPassphrase(true);
        await atomicWrite(target, await exportProfiles(vault, selected, pass));
        await vault.audit(`export ${selected.length}`);
        emit(g, { file: target, profiles: selected.map((p) => p.name) }, () => {
          info(c.green('✔ ') + `Exported ${selected.length} profile(s) to ${target}`);
          if (provider.capabilities.portableExport) {
            warn('Use each login on one machine only: when one copy refreshes its tokens, the other copy stops working.');
          } else {
            warn(`${provider.displayName} logins are bound to this machine; the export will not work on another device.`);
          }
        });
      });
    });

  program
    .command('import <file>')
    .description('add profiles from an export file')
    .action(async (file: string, _opts, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const text = fs.readFileSync(path.resolve(file), 'utf8');
      await withVault(g, async ({ vault }) => {
        const pass = await exportPassphrase(false);
        const res = await importProfiles(vault, text, pass, {
          validateSnapshot: async (meta, snapshot) => {
            let target;
            try {
              target = getProvider(meta.provider);
            } catch (err) {
              return { ok: false, reason: (err as Error).message };
            }
            return target.validateSnapshot ? target.validateSnapshot(snapshot) : { ok: true };
          },
        });
        emit(g, { imported: res.imported.map((p) => p.name), skipped: res.skipped }, () => {
          for (const p of res.imported) info(c.green('✔ ') + `Imported ${describeProfile(p)}`);
          for (const s of res.skipped) info(c.yellow('- ') + `Skipped ${s.name}: ${s.reason}`);
        });
      });
    });
}

async function exportPassphrase(confirmTwice: boolean): Promise<string> {
  const fromEnv = process.env.AI_LOCKER_EXPORT_PASSPHRASE;
  if (fromEnv !== undefined) return fromEnv;
  if (!isInteractive()) {
    throw new LockerError('An export passphrase is required.', 'E_NEED_PASSPHRASE', 'Set AI_LOCKER_EXPORT_PASSPHRASE.');
  }
  for (;;) {
    const first = await promptPassphrase('Export file passphrase');
    if (!confirmTwice) return first;
    try {
      checkPassphrase(first);
    } catch (err) {
      note(c.red((err as Error).message));
      continue;
    }
    if ((await promptPassphrase('Repeat export passphrase')) === first) return first;
    note(c.red('Passphrases did not match.'));
  }
}

// eslint-disable-next-line no-control-regex
const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

export function printTable(rows: string[][], header: string[]): void {
  const widths = header.map((_, i) => Math.max(...rows.map((r) => visibleLength(r[i] ?? ''))));
  for (const r of rows) {
    info(r.map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(cell)))).join('  ').trimEnd());
  }
}
