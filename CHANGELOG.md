# Changelog

## 2026-11-24 (herdr → hc)

- replaced herdr (the multiplexer) with **hc / herdr-core** everywhere: `bootstrap.sh`, `bootstrap.ps1`,
  `apply`, `doctor`, `reset`, `packages.lock.json` (`herdr 0.9.5` + `tsk 0.13.0` -> `hc 0.1.22`).
- dropped `tsk` entirely (it was a herdr plugin): no more `tsk setup herdr|pi`; `skills/tsk-cli` is
  ignored on capture instead of managed.
- new `home/herdr-core/`: `config.toml` (`notes`, `draft_wait`, `wait_timeout`) and role templates
  `worker` (ontoken/glm-5.3), `reviewer` (ontoken/gpt-6.1-sol, thinking medium), `planner`
  (ontoken/claude-sonnet-5.5) — run them with `hc run --bg --name t12 worker "task"`.
- `apply`/`bootstrap` now link `pi` into `~/.local/bin` (a `pi.cmd` shim on Windows): hc starts
  programs with the core's own PATH, which has no `~/.bun/bin`, so `hc run … pi` failed with
  `spawn_failed` before this.
- `doctor`: tool rows are now `pi, git, gh, jq, hc, codebase-memory-mcp`; the herdr-integration rows
  became one `hc templates` row (count on disk vs count in the repo).
- `pr-gate notify()` uses `hc send $HC_TERMINAL_ID` (then `osascript`/`notify-send`) instead of
  `HERDR_ENV=1` + `herdr notification show`.
- skills: `parallel-pr` rewritten for hc (`hc run/ls/get/send/wait`, plain `git worktree add`), new
  `hc-cli` skill (short manual; `hc --skill` is the full one); `AGENTS.md` gained a "Terminals and
  delegation (hc / herdr-core)" section.
- Pi needs no hc extension: it already reports status over OSC 7501, which hc reads
  (`hc get <t>` → `status.app/state`), so `herdr integration install pi` is gone.

## 2026-11-24 (capture)

- setup.mjs: package entries may be objects (`{source, extensions}`), so `doctor`, `buildLock` and
  `capture` no longer crash on `src.startsWith`; `extensionChangelogVersions` is treated as a
  volatile settings key (Pi rewrites it, it is not config).
- models.json.tmpl reduced to the `ontoken` provider only; per-machine router providers stay local.
- added MCP servers `browseros`, `svelte`, `doop` (no secrets, fixed URLs).
- added packages: anti-slop, @sveltejs/pi, @plannotator/pi-extension, pi-advisor-flow, billion-context.
- removed self-compact from user packages (kept per project where used).
- remote-pi: extension `dist/index.js` filtered (relay client only).
- ontoken-auto slots: solid → glm-5.3, strong → kimi-k3.
- herdr: `ui.status_indicators = dots`.
- updated npm:pi-web-access: 0.44.0 -> 0.48.0
- updated npm:pi-schedule-prompt: 0.4.1 -> 0.5.1
- updated https://github.com/priaculun/ontoken-auto: 1.3.1@9d2afce -> 1.3.1@d716a1c
- updated npm:@tintinweb/pi-subagents: 0.22.0 -> 0.26.3
- added git:github.com/miqdadbadjuber/anti-slop (3.2.32@7f6a03d)
- added npm:@sveltejs/pi (0.1.0)
- added npm:@plannotator/pi-extension (0.29.3)
- added npm:pi-advisor-flow (0.17.0)
- added npm:billion-context (0.1.216)
- removed https://github.com/priaculun/self-compact
- tool pi: 1.4.0 -> 1.6.0

## 2026-10-25 (capture)

- tool herdr: 0.9.0 -> 0.9.5

## 2026-10-25 — initial

- Initial capture: Pi 1.4.0, 12 packages (see packages.lock.json), 8 providers, 2 MCP servers,
  4 subagent overrides, skills hindsight-memory + parallel-pr, merge-guard extension, pr-gate 1.0.0,
  herdr config.
- ontoken-auto: `jev.keyFile` (absolute path) replaced by `~/.pi/agent/secrets/typesafe_api_key`,
  written by `render` from `TYPESAFE_API_KEY`.
