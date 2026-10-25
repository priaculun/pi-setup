# AGENT-SETUP — instructions for a coding agent on a new machine

You are setting up the user's Pi coding-agent environment from this repo.
Follow the steps in order. Do not improvise around failures; report them.

## Rules

- **Never print, log, echo or commit secret values.** Only print variable *names*.
  `secrets.env` lives outside the repo (`node scripts/setup.mjs secrets path`).
- Never commit `secrets.env`, `*.bak-*`, or anything under `~/.pi/agent/{sessions,git,npm/node_modules}`.
- Do not edit files under `~/.pi/agent` by hand to "make it work" — fix the repo and re-run `apply`.
- Ask the user before: `reset`, `apply --force`, `capture --prune`, `secrets push`, installing extra system packages.
- Files written by other tools are **not** managed here (do not copy them in):
  `extensions/herdr-agent-state.ts` (herdr), `skills/tsk-cli` (tsk), `~/.pi/remote/skills/agent-network` (remote-pi).

## 1. Detect the platform

| Platform | Entry point |
|---|---|
| macOS | `./bootstrap.sh` (needs Homebrew) |
| Ubuntu / Debian | `./bootstrap.sh` (uses sudo apt) |
| Omarchy / Arch | `./bootstrap.sh` (uses sudo pacman) |
| Windows 11 | `powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1` (uses winget) |

First run the read-only check: `./bootstrap.sh --check` / `bootstrap.ps1 -Check`.
`sudo`, `gh auth login`, and Windows UAC prompts need the human — ask them to run those steps if you cannot.

## 2. Secrets

`apply` pulls them automatically when `gh` is logged in with access to the private repo
`priaculun/pi-setup-secrets`. Otherwise follow `SECRETS.md`. Verify with:

```sh
node scripts/setup.mjs secrets check     # names only, never values
```

Missing secrets do not break anything: that template is skipped and `doctor` reports an error.

## 2b. Replace an existing Pi setup (only if the user asked for a clean install)

If this machine already has Pi config the user wants replaced, run `reset` **before** apply.
Nothing is deleted: old config moves to `~/.pi-backup-<timestamp>/`.

```sh
node scripts/setup.mjs reset --dry-run    # show what would move; changes nothing
node scripts/setup.mjs reset              # refuses while any pi process is running
```

| reset does | Details |
|---|---|
| Moves to backup | everything in `~/.pi/agent` (settings, models, mcp, extensions, skills, sessions, auth, caches) + herdr `config.toml` |
| Keeps | Pi install (`~/.pi/agent/{bin,install,win-git-bash}` of the official installer), `~/.pi/remote` (phone pairing), `secrets.env` |
| Removes | `~/.config/pi-setup/state.json` (so render treats the machine as new) |

- If it reports running pi processes: ask the user to close them. Use `--yes` only if the user confirms
  (e.g. you yourself are running inside Pi — then tell the user to restart Pi after apply).
- After apply, OAuth logins (`/login`) must be redone; sessions can be copied back from
  `<backup>/agent/sessions` if the user wants them.

## 3. Apply

```sh
./bootstrap.sh          # or: node scripts/setup.mjs apply
```

`apply` = render files → `pi update --extensions` (installs all packages from `settings.json`)
→ `herdr integration install pi`, `tsk setup herdr`, `tsk setup pi`, codebase-memory config → `doctor`.

## 4. Verify

```sh
node scripts/setup.mjs doctor           # must end with "0 error(s)"
pi list                                 # 12 packages
pi -p --no-session "say ok"             # model + key work
```

Expected warnings that are fine: tool version newer than `packages.lock.json` (info),
`gh auth` when the user chose not to log in.

## 5. Optional, ask first

| Item | Command | When |
|---|---|---|
| remote-pi background service | `remote-pi install` | user wants phone/remote access (needs Tailscale relay) |
| Zed ACP bridge | `npm i -g pi-acp` | user uses Zed |
| Tailscale | https://tailscale.com/download | required for `PI_HOST_*`, `MCP_HOST_*`, `REMOTE_PI_RELAY_HOST` (100.x hosts) |
| pr-gate per repo | `pr-gate init` inside each repo | before parallel agent work |

## 6. Report

Tell the user: platform, what was installed, `doctor` summary, and any skipped step with the reason.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `drift <file>` | file changed locally after the last apply | `capture` to keep it, or ask → `apply --force` (makes `.bak-*`) |
| `skip models.json: missing …` | secrets not present | `SECRETS.md` |
| package `not installed` | install failed / offline | `pi update --extensions`, read the npm error |
| `pr-gate` not found (Windows) | `~/.local/bin` not on PATH or no Git Bash | re-open terminal; `winget install Git.Git` |
| hindsight / alfarouter / remote relay timeout | 100.x hosts are Tailscale | join the tailnet |
