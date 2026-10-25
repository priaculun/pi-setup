# Changelog

## 2026-10-25 — initial

- Initial capture: Pi 1.4.0, 12 packages (see packages.lock.json), 8 providers, 2 MCP servers,
  4 subagent overrides, skills hindsight-memory + parallel-pr, merge-guard extension, pr-gate 1.0.0,
  herdr config.
- ontoken-auto: `jev.keyFile` (absolute path) replaced by `~/.pi/agent/secrets/typesafe_api_key`,
  written by `render` from `TYPESAFE_API_KEY`.
