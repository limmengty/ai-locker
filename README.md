# ai-locker

Keep several Claude Code logins in an encrypted vault and switch the active one with a single command. Works on Windows and macOS (and Linux).

Run it with `npx @anantbot/ai-locker <command>`, or install it once with `npm install -g @anantbot/ai-locker` and use the shorter `ai-locker <command>`. The rest of this README uses the short form.

```sh
npx @anantbot/ai-locker init                    # create the vault, choose a passphrase
npx @anantbot/ai-locker add work --from-live    # save the account you're logged in with now
npx @anantbot/ai-locker add personal            # log in to another account and save it
npx @anantbot/ai-locker use work                # switch Claude Code to "work"
npx @anantbot/ai-locker status --usage          # active account + session/weekly usage
```

## How it works

Claude Code keeps exactly one login per configuration directory:

| OS | Live credential store | Account info |
|---|---|---|
| Windows / Linux | `~/.claude/.credentials.json` (plaintext, user-only ACL / mode 0600) | `oauthAccount` in `~/.claude.json` |
| macOS | Keychain item `Claude Code-credentials` | `oauthAccount` in `~/.claude.json` |

`ai-locker` stores every account in its own encrypted vault and, on `use`, swaps the chosen one into that single live slot. It never runs `/logout` (which may revoke tokens server-side); it only moves credentials.

Claude Code refreshes its tokens while it runs. Before overwriting the live slot, `ai-locker` saves the current login back into the vault, so the copy you switch back to is always the newest one.

A switch is a small transaction:

1. Refuse if any Claude Code process is running, since it could write old tokens back (`--force` overrides).
2. Save the live login into the vault. A login that isn't saved yet is never overwritten silently: you're asked to save it, or you pass `--save-live-as <name>` or `--discard-live`.
3. Write an encrypted rollback record.
4. Write the target profile's credentials and `oauthAccount`.
5. Verify with `claude auth status --json`, checking that the email matches. On failure the previous login is restored automatically.

If the process is killed partway through, `ai-locker doctor` reports it and `ai-locker rollback` restores the previous login. Until then, other commands that change the login refuse to run, so the saved login can't be overwritten. Pressing Ctrl+C during `add` cancels the login, and `ai-locker` still restores your previous account.

`ai-locker` only launches `claude` from absolute `PATH` entries, never from the current directory, so a `claude.exe` planted in a cloned repo is never run.

## Security model

```
passphrase ──Argon2id (64 MiB, t=3) or scrypt──▶ KEK ──AES-256-GCM──▶ wraps VDK (random 256-bit)
VDK ──HKDF-SHA256(purpose, id)──▶ per-file key ──AES-256-GCM (AAD = vault id + purpose + id)──▶ vault files
```

- **Stolen `~/.ai-locker` is useless without the passphrase.** Every profile, the profile list (names, emails), and the rollback record are encrypted. Each file is bound to its id, so blobs can't be swapped between profiles.
- **OS unlock (optional, on by default).** A copy of the data key is protected by Windows DPAPI (CurrentUser) or the macOS login Keychain, so routine commands don't prompt. It only decrypts for your OS user on this machine. Turn it off with `ai-locker config os-unlock off`, or bypass it for one command with `--strict`.
- **The active login is as exposed as Claude Code makes it.** Claude Code needs it in its own store to work. `ai-locker lock` moves it into the vault and leaves Claude Code logged out; `ai-locker unlock` brings it back.
- **Secrets never touch argv, logs, or `--json` output.** Keys go to PowerShell or `security` over stdin. One exception: on macOS, a credentials payload too large for `security -i` (many MCP connector tokens) is passed as an argument, where only processes of the same user can see it, and those can already query the Keychain.
- **Zero native dependencies.** Crypto comes from Node's built-in `crypto`. OS key stores are reached through the in-box `powershell.exe` and `/usr/bin/security`, so `npx` works without build tools.
- `~/.ai-locker` is created with mode 0700 on macOS/Linux, and with an ACL granting only your user on Windows.

What it does not protect against: malware already running as your user while the vault is unlocked (OS unlock on) or while a login is active. That is the same exposure Claude Code's own storage has.

## Commands

| Command | What it does |
|---|---|
| `init [--no-os-unlock] [--scrypt]` | Create the vault. |
| `add <name>` | Save the current login (if unsaved), log Claude Code out locally, run `claude auth login`, and save the new account. Options: `--email`, `--sso`, `--console`, `--manual` (log in yourself in another terminal). |
| `add <name> --from-live` | Save the account that is logged in right now. |
| `use [profile]` | Switch to a profile (picker if omitted). Alias `switch`. |
| `list` / `ls` | List profiles (`*` marks the active one). |
| `status [--usage]` | Active profile, live login, token expiry; `--usage` fetches usage windows from Anthropic. |
| `lock` / `unlock` | Move the live login into the vault, or restore it. |
| `rename <profile> <new>` / `remove <profile>` | Manage profiles. |
| `export <file>` / `import <file>` | Move profiles to another machine, encrypted with a separate passphrase. |
| `passphrase` | Change the vault passphrase and rotate the data key. Every profile is re-encrypted, crash-safely, so an old `vault.json` plus a leaked old passphrase can't read anything newer. |
| `config show` / `config os-unlock on\|off` | Vault settings. |
| `rollback` | Restore the login saved before an interrupted operation. |
| `doctor` | Diagnose the vault, permissions, Claude Code install, and running sessions. |

Global flags: `--json` for machine-readable output, `--strict` to always ask for the passphrase.

Environment variables: `AI_LOCKER_HOME` (vault location, default `~/.ai-locker`), `AI_LOCKER_PASSPHRASE` (non-interactive unlock, e.g. CI), `AI_LOCKER_EXPORT_PASSPHRASE`, `AI_LOCKER_CLAUDE_BIN`. `CLAUDE_CONFIG_DIR` is respected the same way Claude Code respects it, including the hashed macOS Keychain item name.

## Caveats

- **Quit Claude Code before switching.** That includes the VS Code/JetBrains extensions. A running session keeps its old tokens in memory and may write them back.
- **Don't use one login on two machines at once.** When one copy refreshes, the other copy's refresh token stops working. `export` is for moving a login, not cloning it.
- **Environment overrides win.** If `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, Claude Code ignores the stored login, so switching has no visible effect. `doctor` warns about this.
- **MCP connector tokens are per profile.** They live in the same credentials file, so they switch along with the account.
- **One active account at a time.** Running two accounts in parallel through separate `CLAUDE_CONFIG_DIR`s is unreliable on macOS when tokens are copied rather than created by a fresh login, so this tool deliberately swaps a single slot.
- `status --usage` calls an undocumented Anthropic endpoint (`/api/oauth/usage`) with the profile's own access token. Its format may change.

## Development

```sh
npm install
npm test          # vitest: crypto, vault, stores, switch transactions (temp dirs only)
npm run build     # tsup -> dist/cli.js
node dist/cli.js --help
```

Tests never touch your real `~/.claude`. They use temp directories and a fake provider. CI runs on Windows, macOS, and Linux with Node 20 and 24.

## License

MIT
