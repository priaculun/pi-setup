# Global agent rules

## Code navigation (codebase-memory / cbm)
- In code repos, locate code with cbm before grep/read: `cbm_search_graph` (query or name_pattern) → `cbm_trace_path` → `cbm_get_code_snippet`. Read whole files only when needed.
- Do not use `semantic_query`; keyword `query` is far more accurate. Keep `limit` small (10–20).
- Projects auto-index on session start and reindex on change; call `cbm_index_repository` only if `cbm_index_status` shows the project missing.
- Before reviews/refactors, use `cbm_detect_changes` for blast radius.

## Parallel work (worktree → PR)
- One task = one branch = one worktree = one PR. Never edit the main checkout or another agent's worktree.
- Workers never merge, never push to main, and only force-push their own branch with `--force-with-lease`.
- A task is done only when its PR is open, CI is green, and the branch is up to date with origin/main.
- Merge only via `pr-gate merge <pr>`, one PR at a time; high-risk PRs need the user's `pr-gate approve`. Never approve for the user.
- Full procedure (coordinator, worker, reviewer roles): load the `parallel-pr` skill.
