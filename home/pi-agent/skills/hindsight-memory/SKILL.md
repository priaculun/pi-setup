---
name: hindsight-memory
description: Long-term memory via MCP hindsight-omp. Use BEFORE answering about the user's past decisions, setup, projects or preferences (recall), and to save new decisions/preferences (retain).
---

# Hindsight Memory (bank: omp)

Long-term memory via MCP server `hindsight-omp`. Tools: `mcp__hindsight_omp__retain`, `recall`, `reflect`.

## When to use (proactive, no need to ask)
- **retain**: user shares personal facts, preferences, decisions, projects, milestones, relationships
- **recall**: BEFORE answering anything about user's past decisions, setup, projects, or preferences. If unsure whether memory might be relevant, recall anyway.
- **reflect**: user asks for synthesis/analysis over history ("kenapa", "gimana polanya")

## Low-cost calling pattern (use this)
```
recall({ query: "<short query>", max_tokens: 800, budget: "low" })
```
- Always set `max_tokens: 800` unless user explicitly asks for deep recall.
- Do NOT set `include_chunks`, `include_entities`, `include_source_facts` (all default false — leave them).
- One recall per question is enough. Don't loop with reformulated queries.

## retain pattern
```
retain({ content: "<1-3 sentences, self-contained>", tags: ["project:<name>"], context: "<topic>" })
```
Keep content self-contained (future reader has no conversation context). Fire-and-forget: don't wait/verify.

## Notes
- First recall after idle can take ~15s (server reranker warmup). Just wait, don't retry.
- All memory is in bank `omp` — no bank_id parameter needed anywhere.
