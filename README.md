# ai-locker

Keep several AI CLI logins — Claude Code, Qoder CLI, GitHub Copilot CLI, Google Antigravity CLI and Kiro CLI — in one encrypted vault and switch the active one with a single command. Works on Windows and macOS (and Linux).

## Install

```sh
npm install -g @anantbot/ai-locker
```

This installs the `ai-locker` command:

```sh
ai-locker init                    # create the vault, choose a passphrase
ai-locker add work --from-live    # save the account you're logged in with now
ai-locker add personal            # log in to another account and save it
ai-locker use work                # switch Claude Code to "work"
ai-locker status --usage          # active account + session/weekly usage
```

Qoder CLI uses the same commands with `--provider qoder` (or set `AI_LOCKER_PROVIDER=qoder`):

```sh
ai-locker --provider qoder add work --from-live
ai-locker --provider qoder use work
ai-locker --provider qoder status
```

GitHub Copilot CLI, Google Antigravity CLI and Kiro CLI use the same commands:

```sh
ai-locker --provider copilot add work --from-live   # save the account Copilot is using now
ai-locker --provider copilot add personal           # runs `copilot login`
ai-locker --provider agy add work                   # opens the agy TUI; type /login, then /quit
ai-locker --provider agy use work
ai-locker --provider kiro add work                  # runs `kiro-cli login` and saves what it wrote
ai-locker --provider kiro use work
```

`agy` and `antigravity` are aliases for the same provider. Antigravity has no non-interactive login command, so `add` opens the agy TUI in the current window for you: type `/login`, finish the browser sign-in, then `/quit` to hand control back. Pass `--manual` to run `agy` yourself in another terminal instead.

To try it without installing, put `npx @anantbot/ai-locker` in front of any command, for example `npx @anantbot/ai-locker use work`. To update later, run `npm update -g @anantbot/ai-locker`.

## How it works

Each provider keeps exactly one live login per configuration directory. `ai-locker` stores every account in its own encrypted vault and, on `use`, swaps the chosen one into that single live slot. It never runs a logout (which may revoke tokens server-side); it only moves credentials.

### Claude Code (default)

| OS | Live credential store | Account info |
|---|---|---|
| Windows / Linux | `~/.claude/.credentials.json` (plaintext, user-only ACL / mode 0600) | `oauthAccount` in `~/.claude.json` |
| macOS | Keychain item `Claude Code-credentials` | `oauthAccount` in `~/.claude.json` |

### Qoder CLI

| What | Where |
|---|---|
| Login | `~/.qoder/.auth/user` (one opaque, machine-bound blob) |
| Device identity | `~/.qoder/.auth/machine_id` |
| Account info | `qodercli status -o json` (email, plan, account type) |

`QODER_CONFIG_DIR` (full path) and `QODER_CONFIG_DIR_NAME` (a directory name under your home) are honoured the same way qodercli honours them. Qoder's login blob can only be read by the same `machine_id`, so Qoder profiles are **not portable between machines**; `export` warns about this and `import` skips profiles captured elsewhere. The Qoder IDE is a separate product and is not managed.

### GitHub Copilot CLI

| What | Where |
|---|---|
| Tokens | OS keyring, service `copilot-cli` (two items per account: `host:login` and `host:login:github`) |
| Account list | `loggedInUsers` and `lastLoggedInUser` in `~/.copilot/config.json` |
| Plan / quota | `%LOCALAPPDATA%\copilot\copilot-user-cache.json` (Windows) or the platform cache directory |

Copilot supports GitHub Enterprise hosts; pass `--host https://github.example.com` to `add`. Changing accounts edits only the active entry in the roster, so other GitHub logins already present in Copilot are left alone. Copilot profiles are **portable between machines** because the token is not device-bound. `ai-locker` verifies the saved token against `${host}/api/v3/user` (or `api.github.com/user`), which does not consume Copilot credits.

### Google Antigravity CLI (`agy`)

| What | Where |
|---|---|
| Login | OS keyring, service `gemini`, account `antigravity` (Windows target `gemini:antigravity`) |
| State | `~/.gemini/antigravity-cli` and `~/.gemini/config` |
| Account info | `id_token_email` and `auth_method` inside the keyring JSON |

Antigravity signs in inside its TUI (`/login`), so `ai-locker add` clears the keyring item, opens the agy TUI, waits for you to sign in and quit, then captures what agy wrote. Verification runs `agy models`, which authenticates and refreshes the OAuth token without using model credits. Profiles are portable between machines.

agy falls back to a **file credential** instead of the keyring when it runs over SSH, as root, or when the keyring times out. `ai-locker` refuses to switch in those conditions, because moving the keyring item would have no effect.

### Kiro CLI (`kiro`, alias `kiro-cli`)

| What | Where |
|---|---|
| Login | `auth_kv` row `kirocli:social:token` (JSON: access/refresh token, expiry, provider, `profile_arn`) in `data.sqlite3` |
| Selected profile | `state` row `api.codewhisperer.profile` beside it |
| Account info | `kiro-cli whoami --format json` |
| Store location | the `data.sqlite3` next to the `kiro-cli` binary (Windows installs keep it under `%LOCALAPPDATA%\Kiro-Cli`); otherwise the first of Kiro's own data directories that has one |

Kiro keeps its login in a SQLite database rather than the OS keyring, so `ai-locker` reads and writes **only those two rows** and leaves every other row (telemetry, knowledge-base state) untouched. It reads the database through Node's built-in `node:sqlite`, which needs Node.js 22.13 or newer on the machine running `ai-locker`; on older Node the Kiro commands fail with a clear message instead of half-working. The Kiro desktop IDE stores its own login and is not managed.

`kiro-cli login` takes no account flags, so `add` never passes `--email`, `--sso`, `--console` or `--host`; for AWS Identity Center or a specific social provider, run `kiro-cli login` yourself and then `add <name> --from-live`. `KIRO_API_KEY` overrides the stored login, so switching refuses to run while it is set. `add` opens Kiro's own login flow in your terminal, so the browser must already be signed in to the account you want to capture. `kiro-cli` also offers `switch`, `profile` and `logout`; `ai-locker` does not call them — it edits the two rows directly, which never revokes anything server-side.

Kiro rotates the refresh token whenever it renews, so a Kiro profile is **copyable between machines but not cloneable**: after an `export`/`import`, only the newest copy stays valid. Set `KIRO_TEST_DB_PATH` to point `ai-locker` and Kiro CLI at a scratch database when you want to exercise a switch without touching your real login.

Claude Code refreshes its tokens while it runs; Qoder CLI, Copilot, agy and Kiro CLI may refresh their credentials too. Before overwriting the live slot, `ai-locker` saves the current login back into the vault, so the copy you switch back to is always the newest one.

A switch is a small transaction:

1. Refuse if a provider process is running, since it could write old tokens back (`--force` overrides).
2. Save the live login into the vault. A login that isn't saved yet is never overwritten silently: you're asked to save it, or you pass `--save-live-as <name>` or `--discard-live`.
3. Write an encrypted rollback record.
4. Write the target profile's credentials (and, for Claude Code, `oauthAccount`).
5. Verify with the provider's own status command or API, checking that the account matches. On failure the previous login is restored automatically.

If the process is killed partway through, `ai-locker doctor` reports it and `ai-locker --provider <id> rollback` restores the previous login. Rollback records are kept per provider, so an interrupted Copilot switch does not block Qoder. Until the record is resolved, other operations on that provider refuse to run, so the saved login can't be overwritten. Pressing Ctrl+C during `add` cancels the login, and `ai-locker` still restores your previous account.

`ai-locker` only launches a provider executable from absolute `PATH` entries, never from the current directory, so a `claude.exe`, `qodercli.exe`, `copilot.exe`, `agy.exe` or `kiro-cli.exe` planted in a cloned repo is never run.

## Security model

```
passphrase ──Argon2id (64 MiB, t=3) or scrypt──▶ KEK ──AES-256-GCM──▶ wraps VDK (random 256-bit)
VDK ──HKDF-SHA256(purpose, id)──▶ per-file key ──AES-256-GCM (AAD = vault id + purpose + id)──▶ vault files
```

- **Stolen `~/.ai-locker` is useless without the passphrase.** Every profile, the profile list (names, emails), and the rollback record are encrypted. Each file is bound to its id, so blobs can't be swapped between profiles.
- **OS unlock (optional, on by default).** A copy of the data key is protected by Windows DPAPI (CurrentUser) or the macOS login Keychain, so routine commands don't prompt. It only decrypts for your OS user on this machine. Turn it off with `ai-locker config os-unlock off`, or bypass it for one command with `--strict`.
- **The active login is as exposed as the provider makes it.** Each CLI needs it in its own store to work. `ai-locker lock` moves it into the vault and leaves the provider logged out; `ai-locker unlock` brings it back.
- **Secrets never touch argv, logs, or `--json` output.** Keys go to PowerShell or `security` over stdin. One exception: on macOS, a credentials payload too large for `security -i` (many MCP connector tokens) is passed as an argument, where only processes of the same user can see it, and those can already query the Keychain.
- **Zero native dependencies.** Crypto comes from Node's built-in `crypto`. OS key stores are reached through the in-box `powershell.exe` and `/usr/bin/security`, so installing needs no build tools.
- `~/.ai-locker` is created with mode 0700 on macOS/Linux, and with an ACL granting only your user on Windows.

What it does not protect against: malware already running as your user while the vault is unlocked (OS unlock on) or while a login is active. That is the same exposure Claude Code's own storage has.

## Commands

| Command | What it does |
|---|---|
| `init [--no-os-unlock] [--scrypt]` | Create the vault. |
| `add <name>` | Save the current login (if unsaved), log the provider out locally, run its login command (for agy, open the agy TUI for a `/login`), and save the new account. Claude Code options: `--email`, `--sso`, `--console`; Copilot: `--host`; `--manual` logs in yourself in another terminal. |
| `add <name> --from-live` | Save the account that is logged in right now. |
| `use [profile]` | Switch to a profile (picker if omitted). Alias `switch`. |
| `list` / `ls` | List profiles (`*` marks the active one). |
| `status [--usage]` | Active profile, live login, token expiry; `--usage` fetches usage windows when the provider exposes them (currently Claude Code). |
| `lock` / `unlock` | Move the live login into the vault, or restore it. |
| `rename <profile> <new>` / `remove <profile>` | Manage profiles. |
| `export <file>` / `import <file>` | Move profiles to another machine, encrypted with a separate passphrase. Qoder profiles are machine-bound and are skipped on another machine; Kiro profiles import but invalidate the copy they came from once the token refreshes. |
| `passphrase` | Change the vault passphrase and rotate the data key. Every profile is re-encrypted, crash-safely, so an old `vault.json` plus a leaked old passphrase can't read anything newer. |
| `config show` / `config os-unlock on\|off` | Vault settings. |
| `rollback` | Restore the login saved before an interrupted operation on the selected provider. |
| `doctor` | Diagnose the vault, permissions, the selected provider install, and running sessions. |

Global flags: `--provider <claude-code|qoder|copilot|agy|kiro>` to pick the provider (default `claude-code`, aliases `antigravity` and `kiro-cli`), `--json` for machine-readable output, `--strict` to always ask for the passphrase.

Environment variables: `AI_LOCKER_HOME` (vault location, default `~/.ai-locker`), `AI_LOCKER_PASSPHRASE` (non-interactive unlock, e.g. CI), `AI_LOCKER_EXPORT_PASSPHRASE`, `AI_LOCKER_PROVIDER`, `AI_LOCKER_CLAUDE_BIN`, `AI_LOCKER_QODER_BIN`, `AI_LOCKER_COPILOT_BIN`, `AI_LOCKER_AGY_BIN`, `AI_LOCKER_KIRO_BIN`. `CLAUDE_CONFIG_DIR`, `QODER_CONFIG_DIR`, `QODER_CONFIG_DIR_NAME`, `COPILOT_HOME`, `KIRO_HOME`, `KIRO_TEST_DB_PATH` and `HOME`/`USERPROFILE` are respected the same way each provider respects them (Claude Code also gets the hashed macOS Keychain item name).

## Caveats

- **Quit the provider before switching.** For Claude Code that includes the VS Code/JetBrains extensions; for Qoder any running `qodercli` session; for Copilot any `copilot` session; for Antigravity any `agy` TUI; for Kiro any `kiro-cli` session (its TUI runs as `bun.exe ... tui.js`, which is detected too). A running session keeps its old tokens in memory and may write them back.
- **Don't use one login on two machines at once.** When one copy refreshes, the other copy's refresh token stops working. `export` is for moving a login, not cloning it. This is especially strict for Kiro CLI, which rotates the refresh token on every renewal and treats a reused token as invalid.
- **Environment overrides win.** If `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, Claude Code ignores the stored login. Qoder respects `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_JOB_TOKEN` and `QODER_SERVICE_ACCOUNT_KEY`. Copilot respects `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN`. Antigravity respects `AGY_ADC_AUTH`, `GEMINI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `ANTIGRAVITY_OAUTH_CREDENTIALS_JSON`, `AGY_ACCOUNT` and the `AGY_LLM_GATEWAY_*` family. Kiro respects `KIRO_API_KEY`. `ai-locker` refuses to switch while one is set. `doctor` warns about this.
- **Qoder credentials are machine-bound.** A profile saved on one machine cannot be restored on another (the `machine_id` differs), even through `export`/`import`. Copilot and Antigravity profiles are portable; Kiro profiles are portable but only the newest copy survives a token refresh.
- **Qoder has no CLI logout command.** `ai-locker lock` removes `~/.qoder/.auth/user`, which is the equivalent local logout; the Qoder TUI also has `/logout`. Copilot and Antigravity are logged out locally by deleting their keyring items (`COPILOT_DISABLE_KEYTAR`, `storeTokenPlaintext` and agy's SSH/root file fallback are refused, see above). For Kiro, `ai-locker lock` deletes the same two rows `kiro-cli logout` deletes, minus the server-side revocation call, so the login can be restored by `unlock`.
- **MCP connector tokens are per profile.** For Claude Code they live in the same credentials file, so they switch along with the account.
- **One active account at a time per provider.** Running two accounts in parallel through separate `CLAUDE_CONFIG_DIR`s is unreliable on macOS when tokens are copied rather than created by a fresh login, so this tool deliberately swaps a single slot. Each provider has its own active slot, so profiles from different providers can be active at the same time. Kiro CLI's own `kiro-cli switch`/`profile` commands manage Identity Center profiles inside one login; they are a different concept from the accounts `ai-locker` swaps.
- `status --usage` calls an undocumented Anthropic endpoint (`/api/oauth/usage`) with the profile's own access token. Its format may change. Qoder CLI and Kiro CLI do not expose usage; Copilot and Antigravity have `/usage` inside their TUIs, which is not managed here. Kiro's credit balance is only visible in the subscribed provider's own console.

## Development

```sh
npm install
npm test          # vitest: crypto, vault, stores, switch transactions (temp dirs only)
npm run build     # tsup -> dist/cli.js
node dist/cli.js --help
```

Tests never touch your real `~/.claude`, `~/.qoder`, `~/.copilot`, `~/.gemini` or Kiro database. They use temp directories, an in-memory keyring, an in-memory Kiro store and fake providers; the real `node:sqlite` code path runs against a scratch database only. CI runs on Windows, macOS, and Linux with Node 20 and 24.

### Adding a provider

1. Create `src/providers/<id>/` with `env.ts` (config paths and overrides), `store.ts` (live read/write/clear), `process.ts` (running-session detection), optionally `status.ts` (identity from the CLI's own status command) and `index.ts` (the `Provider` implementation).
2. Keep the snapshot type opaque: store exactly what the CLI stores, plus only the identity metadata needed for `matchProfile` (`accountKey`, `email`/`username`, expiry). Never derive a fingerprint from mutable tokens only.
3. Implement `preflight()` for environment overrides and unsupported storage modes. Refuse to switch instead of silently doing nothing.
4. Use `verifyLive(expected)` to check the account the provider reports, and prefer a cheap command/API that does not consume credits.
5. Reuse `src/providers/shared/` for CLI doctor rows, keyring availability, and opaque base64 snapshots.
6. Register the id (and any aliases) in `src/providers/index.ts`; add the id to the README tables and `--provider` list.
7. Add a `test/<id>.test.ts` with a fake store plus: read/capture, switch, lock/unlock, rollback, verification failure, malformed snapshot, export/import, and process detection. Run typecheck, lint and the full suite on Windows, macOS and Linux if the store is platform-specific.

## License

MIT
