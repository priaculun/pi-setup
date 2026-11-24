---
name: parallel-pr
description: Parallel task workflow — one task per git worktree, branch and PR; risk-tiered review and merging through pr-gate. Use when splitting work across several agents, working as a worker on a task branch, reviewing a PR, or coordinating/merging PRs (in hc, or with subagents).
---

# Parallel PR workflow

Roles: **coordinator** (plans, spawns, merges), **worker** (one task), **reviewer** (judges one PR).
`pr-gate` is the only merge path; the `merge-guard` extension blocks the others.
GitHub Free + private repos = no branch protection, so these rules ARE the protection.

Everything below runs under `hc` (herdr-core). `hc --skill` is the manual; the short version:
`hc run --bg --name <n> <program|template> "<task>"`, then `hc wait`/`hc send`/`hc read`/`hc kill`+`hc rm`.
Never sleep or poll — `hc wait` is the only way to wait.

## Coordinator

1. **Plan for no overlap.** Break the request into tasks. For each, list the files/modules
   it will likely touch (`cbm_search_graph`, `cbm_trace_path`). Tasks sharing files run
   **sequentially**, not in parallel. Keep 2–4 workers at a time.
   The `planner` template does this step read-only when the shape is unclear:
   `hc run --bg --name plan --cwd <repo> planner "<goal>"`
2. **IDs.** Task `T12` → branch `t12-<slug>` → hc terminal `t12` → PR title `T12: …`.
3. **Spawn a worker.** One worktree per task, created by you (not by the agent):
   ```bash
   git fetch origin
   git worktree add ../<repo>-t12 -b t12-<slug> origin/main
   hc run --bg --name t12 --cwd ../<repo>-t12 worker "<task spec: goal, files in scope, out of scope, acceptance criteria>. Report with hc send $HC_TERMINAL_ID"
   ```
   The `$HC_TERMINAL_ID` in that string is expanded by **your** shell into your own address, so the
   worker gets a literal terminal to report to. Do not rely on a template to do this: a template body
   is a static file and would expand to the worker's own id.
   `worker` is a template in `~/.config/herdr-core/templates/` (`hc templates` lists them with
   their command). Without a template, start the agent explicitly and wait for readiness first:
   ```bash
   hc run --bg --name t12 --cwd ../<repo>-t12 pi --model ontoken/glm-5.3
   hc wait t12
   hc send t12 "<task spec>. Follow the parallel-pr skill as worker."
   ```
   Short tasks without CI babysitting may use a subagent with `isolation: "worktree"` instead.
4. **Monitor** with `hc ls` / `hc get t12`. Do not poll in a loop: `hc wait t12` returns when the
   worker stops working, and a child's report arrives in your input as `<hc from="t12 worker">…</hc>`.
   Ask the user before answering an agent's approval dialog (`status: blocked`).
5. **Review** each PR whose CI is green (see Reviewer). Use the `reviewer` template/agent so the
   reviewing model differs from the worker's.
6. **Merge** in queue order (oldest first), one at a time:
   ```bash
   pr-gate list          # overview: risk, CI, behind, review
   pr-gate merge <pr>    # refuses unless every check passes
   ```
   After each merge, tell remaining workers: `git fetch && git rebase origin/main && git push --force-with-lease`,
   wait for CI, then the PR needs a fresh review (review is bound to the head SHA).
   - **low / medium**: coordinator merges after the review approves.
   - **high**: stop. Tell the user: "PR #N is high risk (<reason>). Approve with `pr-gate approve N`."
     Never approve on the user's behalf.
7. **Cleanup** after merge: `hc kill t12`, `hc rm t12`, then `git worktree remove ../<repo>-t12`.

## Worker

- Work only inside your worktree, on your branch. Never touch the main checkout or another worktree.
- Setup: copy untracked env files from the main checkout if needed (`.env*`), install deps,
  use a unique dev-server port (e.g. 3000 + task number).
- Small focused commits. Run tests/lint/typecheck locally before pushing.
- Open the PR early: `git push -u origin HEAD` then `gh pr create --fill --title "T12: …"` (draft while WIP).
- **Done = all of:** PR open & not draft, CI green, branch up to date with `origin/main`
  (`pr-gate check <pr>` shows only `review` failing), and a summary sent to the coordinator.
  Your task text carries the coordinator's address; if it does not, use your parent:
  `hc send "$(hc get "$HC_TERMINAL_ID" --json | jq -r .parent)" "<summary>"` —
  never `hc send $HC_TERMINAL_ID`, that is your own terminal.
- CI red → fix and push. After **3 failed fix attempts**, stop and report the failure + logs.
- Conflicts → `git fetch && git rebase origin/main`, resolve, re-test, `git push --force-with-lease`.
- Never: merge, push to main, plain `--force`, edit `review:*`/`human:*` labels, run `pr-gate approve`.

## Reviewer

1. Read the diff and the task's acceptance criteria: `gh pr diff <pr>`, `gh pr view <pr>`.
   `pr-gate risk <pr>` shows the computed risk.
2. Look for correctness/security bugs, missing tests, scope creep, and overlap with other
   open PRs (`gh pr list`, compare touched files).
3. Record the verdict (binds to the current head SHA; any new push invalidates it):
   ```bash
   pr-gate review <pr> approve --body "<summary>"                 # optionally --risk high
   pr-gate review <pr> changes --body "<findings: file:line, problem, fix>"
   ```
   Raise risk (`--risk medium|high`) when the change is riskier than its paths suggest
   (e.g. behaviour change in a hot path, data loss potential). You can raise, never lower.

## Risk tiers (computed by pr-gate)

| Tier | Rule | Merged by |
|---|---|---|
| low | docs/tests only, or ≤100 changed lines with no sensitive/dependency paths | coordinator |
| medium | dependency files, or 101–400 lines | coordinator (user notified) |
| high | sensitive paths (auth, session, payment, billing, crypto, migrations, SQL, CI workflows, Docker, infra, `.env`), >400 lines, no CI, or raised by reviewer | user approves, then `pr-gate merge` |

Repos can add sensitive paths in `.github/risk-paths` (base branch), one per line:
`high <ERE>` or `medium <ERE>`. First use in a repo: `pr-gate init` (creates labels).
