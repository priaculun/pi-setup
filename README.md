# pi-setup

Reproducible setup for the [Pi coding agent](https://pi.dev) and its companion tools.
Runs on **macOS, Ubuntu, Omarchy/Arch and Windows 11**. Contains no secrets.

Setup Pi yang bisa direproduksi di macOS, Ubuntu, Omarchy/Arch, dan Windows 11, tanpa data sensitif.
Agent di mesin baru cukup membaca [`AGENT-SETUP.md`](AGENT-SETUP.md).

## Quick start

```sh
git clone https://github.com/priaculun/pi-setup ~/Projects/pi-setup
cd ~/Projects/pi-setup
./bootstrap.sh                 # macOS / Ubuntu / Arch
```

```powershell
git clone https://github.com/priaculun/pi-setup $HOME\Projects\pi-setup
cd $HOME\Projects\pi-setup
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1   # Windows 11
```

Bootstrap installs the prerequisites + tools, logs in to `gh`, pulls secrets ([SECRETS.md](SECRETS.md)),
renders the config, installs every Pi package and runs `doctor`.

## What is included

| Area | Repo path | Installed to |
|---|---|---|
| Global agent rules | `home/pi-agent/AGENTS.md` | `~/.pi/agent/AGENTS.md` |
| Settings + package list | `home/pi-agent/settings.json` | `~/.pi/agent/settings.json` (merged; local-only keys kept) |
| Providers & models (8 providers) | `home/pi-agent/models.json.tmpl` | `~/.pi/agent/models.json` |
| MCP servers (ontoken-media, hindsight) | `home/pi-agent/mcp.json.tmpl` | `~/.pi/agent/mcp.json` |
| Subagent overrides | `home/pi-agent/agents/` | `~/.pi/agent/agents/` |
| Skills (hindsight-memory, parallel-pr) | `home/pi-agent/skills/` | `~/.pi/agent/skills/` |
| merge-guard extension | `home/pi-agent/extensions/merge-guard.ts` | `~/.pi/agent/extensions/` |
| npm peer-fix hook | `home/pi-agent/npm/` | `~/.pi/agent/npm/` |
| Extension configs | `home/pi-agent/{ontoken-auto,web-search,better-custom.state}.json` | `~/.pi/agent/` |
| remote-pi relay | `home/pi-remote/config.json.tmpl` | `~/.pi/remote/config.json` |
| herdr config | `home/herdr/config.toml` | `~/.config/herdr/` · Windows `%APPDATA%\herdr\` |
| pr-gate (merge gate) | `bin/pr-gate` | `~/.local/bin/pr-gate` (+ `pr-gate.cmd` on Windows) |
| Version pins | `packages.lock.json` | — (checked by `doctor`) |

Packages (installed by `pi update --extensions` from `settings.json`):
pi-quiet-tools, pi-codebase-memory-mcp, remote-pi, pi-web-access, pi-ayu-themes, pi-schedule-prompt,
@tintinweb/pi-tasks, @tintinweb/pi-subagents, @ff-labs/pi-fff, and the git packages
[self-compact](https://github.com/priaculun/self-compact), [ontoken-auto](https://github.com/priaculun/ontoken-auto),
[pc-better-custom](https://github.com/priaculun/pc-better-custom).

Tools: Node ≥ 22.19, git, gh, jq, Pi, [herdr](https://herdr.dev), [tsk](https://gettsk.sh),
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp). Windows also needs Git Bash (for `pr-gate`).

**Not managed here on purpose:** sessions, auth/OAuth stores (`auth.json`, `mcp-auth.json`), caches,
`trust.json` (machine paths), remote-pi pairing (`peers.json`), and files other tools install
themselves (`herdr integration install pi`, `tsk setup pi|herdr`, remote-pi's agent-network skill) —
`apply` runs those installers instead.

## Commands

All logic is one cross-platform Node script, `scripts/setup.mjs`:

| Command | Does |
|---|---|
| `apply [--force] [--dry-run] [--no-packages] [--no-post]` | render + install packages + tool integrations + doctor |
| `render [--force] [--dry-run]` | write files only |
| `doctor [--json]` | tools, secrets, file drift, package versions vs lock; exit 1 on errors |
| `capture [--prune] [--dry-run]` | copy the live setup back into the repo (redacted), update lock + CHANGELOG |
| `scan` | secret scan of the repo |
| `secrets init\|pull\|push\|check\|path` | manage `secrets.env` (see SECRETS.md) |
| `reset [--dry-run] [--yes]` | clean slate: move old Pi config to `~/.pi-backup-<stamp>/` (keeps Pi install, remote pairing, secrets) |
| `selftest` | render into a temp HOME and check idempotence, drift guard, redaction (CI) |

Safety: `render` never overwrites a file you changed locally (it compares against the hash it
last wrote). It reports `drift` instead; `--force` overwrites and keeps a `.bak-<timestamp>` copy.

## Maintaining

The machine you work on is the source of truth; the repo follows it.

| Change | Workflow |
|---|---|
| Add a package | `pi install npm:foo` → `node scripts/setup.mjs capture` → commit |
| Remove a package | `pi remove npm:foo` → `capture` → commit |
| Update packages | `pi update --all` → `capture` (lock diff lands in CHANGELOG) → commit |
| Edit AGENTS.md / skill / agent / extension | edit live → `capture` → commit (or edit repo → `apply`) |
| Delete a skill/agent/extension | delete live → `capture --prune` → commit |
| New provider / MCP / key | edit live → `capture` (redacts to `${…}`) → `secrets push` → document in SECRETS.md |
| Other machine | `git pull` → `node scripts/setup.mjs apply` |
| Other machine, replace old setup | `node scripts/setup.mjs reset` → `./bootstrap.sh` |

`capture` always runs `scan` and exits non-zero if anything secret-like remains. CI runs `scan`,
`selftest`, `shellcheck`, `node --check` and gitleaks on every push.

## Layout

```
bootstrap.sh / bootstrap.ps1   prerequisites + tools, then apply
scripts/setup.mjs              render / doctor / capture / scan / secrets
home/pi-agent/                 -> ~/.pi/agent
home/pi-remote/                -> ~/.pi/remote
home/herdr/                    -> herdr config dir
bin/                           -> ~/.local/bin
packages.lock.json             versions captured from the last capture
secrets.env.example            names of every secret
AGENT-SETUP.md                 runbook for agents
SECRETS.md                     how to obtain / rotate secrets
```

## License

MIT
