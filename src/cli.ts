import { Command, CommanderError } from 'commander';
import { LockerError } from './util/errors.js';
import { c } from './util/output.js';
import { DEFAULT_PROVIDER, providerIds } from './providers/index.js';
import { registerSetup } from './cli/commands/setup.js';
import { registerProfiles } from './cli/commands/profiles.js';
import { registerSwitch } from './cli/commands/switch.js';
import { registerInspect } from './cli/commands/inspect.js';
import pkg from '../package.json' with { type: 'json' };

const program = new Command();
program
  .name('ai-locker')
  .description(
    'Keep several AI CLI logins (Claude Code, Qoder, Copilot, Antigravity, Kiro) in an encrypted vault and switch between them.',
  )
  .version(pkg.version)
  .option('--json', 'machine-readable output (tokens are never printed)')
  .option('--strict', 'ignore the OS key cache and always ask for the passphrase')
  .option('--provider <id>', `provider to manage: ${providerIds().join(', ')}`, process.env.AI_LOCKER_PROVIDER ?? DEFAULT_PROVIDER)
  .showHelpAfterError()
  .exitOverride();

registerSetup(program);
registerProfiles(program);
registerSwitch(program);
registerInspect(program);

program.addHelpText(
  'after',
  `
Examples:
  ai-locker init                    create the vault
  ai-locker add work --from-live    save the account you're logged in with
  ai-locker add personal            log in to another account and save it
  ai-locker use work                switch Claude Code to "work"
  ai-locker status --usage          active account and usage windows
  ai-locker --provider qoder list   manage Qoder CLI logins (or set AI_LOCKER_PROVIDER=qoder)
  ai-locker --provider copilot add work --from-live
  ai-locker --provider agy add work      opens the agy TUI for /login

Install the ai-locker command once with: npm install -g @anantbot/ai-locker`,
);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    process.exitCode = report(err);
  }
}

function report(err: unknown): number {
  const json = process.argv.includes('--json');
  if (err instanceof CommanderError) {
    // Help/version output and argument errors were already printed by commander.
    return err.exitCode;
  }
  if (err instanceof Error && err.name === 'ExitPromptError') {
    process.stderr.write('\nCancelled.\n');
    return 130;
  }
  if (err instanceof LockerError) {
    if (json) {
      process.stdout.write(JSON.stringify({ error: { code: err.code, message: err.message, hint: err.hint ?? null } }, null, 2) + '\n');
    } else {
      process.stderr.write(`${c.red('✖')} ${err.message}\n`);
      if (err.hint) process.stderr.write(`  ${c.dim(err.hint)}\n`);
    }
    return 1;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    process.stdout.write(JSON.stringify({ error: { code: 'E_INTERNAL', message } }, null, 2) + '\n');
  } else {
    process.stderr.write(`${c.red('✖')} ${message}\n`);
    if (process.env.AI_LOCKER_DEBUG && err instanceof Error) process.stderr.write(`${err.stack}\n`);
  }
  return 1;
}

void main();
