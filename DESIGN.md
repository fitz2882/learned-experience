# learned-experience: design

## Goal

Give any AI agent a persistent, portable catalogue of problems it has solved before, so that nothing has to be learned twice. The agent checks the catalogue when it hits a problem, applies what worked, reports back whether it worked, and records new lessons. Over time recall gets faster and more reliable because the ranking is fed by real outcomes.

Two constraints shaped every decision:

1. **Model and provider agnostic.** The user owns the catalogue and carries it to any agent, any model, any host. So the server speaks plain MCP over stdio (and optionally streamable HTTP), stores everything in one local file, and never depends on a specific vendor for the core loop.
2. **Deterministic wherever possible.** Only one component involves a model at all (the embedding step), and it is pinned by id so identical inputs always give identical vectors. Everything else, including fingerprinting, lexical search, fusion, ranking, dedup, and clustering, is pure code.

## How it differs from adjacent work

| | learned-experience | Google WikiSkill (arXiv 2608.27454) | General memory servers |
|---|---|---|---|
| When knowledge is used | Online, at the moment of failure | Offline, compiled into SKILL.md between runs | Whenever the agent chooses |
| Retrieval | Fingerprint + dense + BM25 | None (agent is barred from the wiki) | Usually vector only |
| Record shape | Fixed compact schema | Free markdown pages | Free text |
| Feedback | Per-record success/failure counts | Per-skill validation gating | Rarely |
| Dedup | Server-enforced merge | LLM patch-editing | Rarely |
| Interface | MCP | Filesystem | MCP |

The two are complementary: this catalogue is exactly the kind of experience source a WikiSkill-style compiler could distill from. The `consolidate` tool is the seam for that.

## The record

The wire format is the interoperability contract. It is deliberately small. Every field is read by a model on every future recall, so every field has to pay for itself.

```jsonc
{
  "id": "x_9f1c2a4b7d3e",
  "v": 1,
  "kind": "episode",                 // or "rule": a generalisation distilled from several episodes
  "problem": "App cannot connect to local Postgres",           // ≤ 240 chars, generic
  "signals": ["Error: connect ECONNREFUSED 127.0.0.1:5432"],   // ≤ 8 exact strings; the deterministic key
  "context": ["macos", "node", "postgres"],                     // ≤ 10 normalised tags
  "attempts": [                                                 // ≤ 12, ordered
    { "action": "restart app", "result": "failed" },
    { "action": "brew services start postgresql@16", "result": "worked" }
  ],
  "fix": "Start the Postgres service: brew services start postgresql@16",   // ≤ 600 chars
  "avoid": ["Restarting the app does nothing; the DB is not running"],       // ≤ 8
  "root_cause": "Postgres service was not running after reboot",            // ≤ 300, optional
  "outcome": "success",              // success | partial | failure
  "related": [],                     // records with the same symptom but a different fix
  "stats": { "uses": 3, "successes": 3, "failures": 0, "merged": 1, "last_used": "2026-09-01T12:00:03Z" },
  "source": { "agent": "claude-code", "model": "claude-fable-5-1" },
  "fingerprint": "5d41402abc4b2a76b9719d911017c592",
  "created": "2026-09-01T12:00:00Z",
  "updated": "2026-09-01T12:00:03Z"
}
```

`recall` does not return the full record. It returns a terse hit (id, problem, fix, avoid, root_cause, context, outcome, confidence, uses, match) to keep token cost low.

Every string is cleaned on write: credentials are redacted (API keys, tokens, JWTs, bearer headers, `key=value` secrets, emails, URL credentials) and home directories are rewritten to `~` so records compare equal across machines and users.

## Retrieval: three layers, fused deterministically

1. **Exact layer.** Each signal is normalised (lowercase, numbers, hex, hashes, UUIDs, timestamps, and addresses collapsed to `#`) and hashed. A query hits exactly when any signal key matches a stored one in a compatible context, or when the whole-problem fingerprint matches. Exact hits score 1.0 and are marked `exact: true`. No model is involved.
2. **Lexical layer.** A pure TypeScript BM25 index over problem, signals, context, and root cause, with a small deterministic stemmer. Scores are normalised to the best hit for the query.
3. **Dense layer.** Cosine similarity over embeddings of the problem side only (problem + signals + context), so queries and records are symmetric. Default model is all-MiniLM-L6-v2 running locally through ONNX; first use downloads ~23 MB and after that it runs offline. OpenAI-compatible and Ollama providers are opt-in.

Fusion: `base = 0.6 · dense + 0.4 · lexical` (lexical alone when there is no embedder), overridden to 1.0 for exact hits. Then `final = base · (0.7 + 0.3 · confidence)` where confidence is the Bayesian success rate `(successes + 1) / (uses + 2)`. Ties break on id. Non-exact hits below `min_score` (default 0.35) are dropped.

Why this shape: the exact layer makes the common case (same error again) instant and certain; BM25 catches identifier-heavy matches embeddings blur; dense catches paraphrases; confidence lets outcomes reorder everything without touching the similarity signals.

## Never learn the same thing twice

`record` looks for duplicates before inserting, in deterministic order:

1. Same whole-problem fingerprint, any identical signal in a compatible context, or the identical problem statement (normalised).
2. Otherwise a semantic near-duplicate: cosine ≥ 0.92 and problem-token Jaccard ≥ 0.5.

If a candidate's fix is compatible (either side empty, or fix-token Jaccard ≥ 0.4) the report is **merged**: lists are unioned under their caps with existing items kept first, the better-outcome fix wins, the fingerprint is recomputed from the merged identity fields, every index is rebuilt for the record, and `stats.merged` increments. If the fix is genuinely different the new record is **linked** to the candidate through `related`, because two different fixes for the same symptom are two different lessons.

Import uses exactly the same candidate rules. It also remembers which foreign ids it has already folded into which local records, so importing the same file twice never double-counts usage stats.

## The learning loop

```
problem ──▶ recall ──▶ hit? ──yes──▶ apply fix ──▶ reinforce(worked) ──▶ confidence ──▶ ranking
                        │
                        no ──▶ solve ──▶ record ──▶ (merge | link | create)
```

`reinforce` is the only path by which outcomes enter the system. A failed application with a note appends that note to the record's `avoid` list, so the next reader is warned. Nothing here needs an LLM.

`consolidate` clusters similar episodes (union-find over cosine ≥ threshold, or token Jaccard when there is no embedder) and hands the clusters to the agent, which writes a single `kind: "rule"` record. Distillation is the one step that needs a model, so the model does it and the server stays deterministic.

## Storage and portability

- One SQLite file through Node's built-in `node:sqlite` (no native build step). The full record is a JSON column; fingerprint and kind are lifted out for lookups; the embedding is stored beside it, tagged with the model id, so restarts never re-run the model and a model change re-embeds only what is stale.
- WAL mode with `PRAGMA data_version` polling: several agents can share one file at once, and each server reloads its in-memory indexes when another process commits.
- In-memory BM25 and vector indexes rebuilt from the file at startup. Brute force is deliberate: a personal catalogue is thousands of records, not millions, and brute force is deterministic and dependency-free.
- `transfer` exports and imports JSONL. Embeddings are not exported; the destination recomputes them with its own model. Import merges by the same rules as `record`, and on id clash the newer `updated` wins. The tool is confined to `.jsonl` files under one transfer directory, so an agent steered by injected content cannot use it for arbitrary file reads or writes. The CLI `export`/`import` commands, which a human runs, take any path.

## Transport and hosting

- **stdio** is the default because every MCP host speaks it: Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI, Gemini CLI, LangGraph, and anything built on an MCP client SDK.
- `--http` starts a stateless streamable HTTP endpoint at `/mcp` for hosts that prefer a URL or for sharing one catalogue across machines. Put it behind your own auth if you expose it beyond localhost.

## Trigger

MCP cannot intercept a model's reasoning, so on most hosts the "check memory when you hit a problem" trigger is prompt-driven. The server ships its protocol as `instructions` (every host injects those into the model's context), as the `learned-experience://protocol` resource, and as the `solve` prompt. Hosts with rule files (CLAUDE.md, .cursorrules, AGENTS.md) get a two-line snippet in the README.

In Claude Code the trigger is mechanical. A `PostToolUseFailure` hook runs `learned-experience hook`, which:

1. reads the failure payload (`tool_name`, `tool_input`, `error`, `tool_response`);
2. ignores failures the user caused (interrupts, permission denials) and failures of learned-experience's own tools, so it cannot loop;
3. extracts up to four error-like lines as `signals`, tags the tool and the first word of a Bash command as `context`, and builds a generic `problem` line;
4. runs `recall` in-process against the same database the MCP server uses;
5. writes `hookSpecificOutput.additionalContext` with the hits (id, problem, fix, avoid, cause, confidence) and the instruction to `reinforce`, or a one-line nudge to `record` when nothing matches.

Everything the hook does before the lookup is deterministic string processing. The hook never blocks and never fails loudly: any error is logged to stderr and the session continues.

The plugin (`plugin/`) packages the MCP server and the hook so both install with one command; the repository root carries a `marketplace.json` so `claude plugin marketplace add fitz2882/learned-experience` works.

## What is deliberately not here

- No LLM calls inside the server. Summarisation, generalisation, and judgment stay with the agent.
- No cloud dependency for the core loop.
- No free-text memory. The schema is the product; a general memory store is a different tool.

## Future work

- Optional secondary embedding model for reranking.
- Failure hooks for other hosts as they gain hook support.
- A WikiSkill-style compiler that turns `rule` records into SKILL.md files.
