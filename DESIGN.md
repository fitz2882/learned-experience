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

`reinforce` is the path by which fix outcomes enter the system. A failed application with a note appends that note to the record's `avoid` list, so the next reader is warned. Nothing here needs an LLM.

`dismiss` is the path by which matching outcomes enter the system, and it is deliberately separate: a record can hold an excellent fix and still be the wrong answer for a given query. A dismissal stores the query's deterministic keys (problem key plus signal keys) in the record's `dismissed_for` list, so that exact query never surfaces the record again, and increments `stats.dismissed`, which damps the record's fuzzy scores everywhere by `1 / (1 + 0.25 · dismissed)`. Exact fingerprint matches are never damped. Dismissals travel with the record through export and import.

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

In Claude Code the trigger is mechanical. One command, `learned-experience hook`, is registered for four events and dispatches on the event name:

**PostToolUseFailure** (a tool call failed):

1. reads the failure payload (`tool_name`, `tool_input`, `error`, `tool_response`);
2. ignores failures the user caused (interrupts, permission denials) and failures of learned-experience's own tools, so it cannot loop;
3. extracts up to four error-like lines as `signals`, tags the tool and the first word of a Bash command as `context`, and builds a generic `problem` line;
4. runs `recall` in-process against the same database the MCP server uses;
5. writes `hookSpecificOutput.additionalContext` with the hits and the instruction to `reinforce`, or a one-line nudge to `record` when nothing matches.

**UserPromptSubmit** (the user sent a request): the request becomes the `problem`, any error-like lines in it become `signals`, and recall runs with a higher score floor (0.5) because a request is a weaker signal than an error string. Hits are injected before the model starts; a miss is silent, since most requests have no history. Prompts under 20 characters and slash commands are skipped.

**PostToolUse** (a tool call completed): failed calls use the existing failure-recall path. After a successful call, the default-on recording reminder reads the last turn of a supported Claude Code or Codex transcript. Once work crosses the configured threshold (a failure across at least three calls, or fifteen calls), it supplies non-blocking `additionalContext`: record a verified reusable lesson before the final answer, skip trivia, and keep the answer focused on the user's request. It never emits a blocking decision and starts no additional model run. A missing/unknown transcript, a direct `record`/`reinforce` call, the plugin's own tools, or an existing Codex final response suppress the reminder. `LEARNED_EXPERIENCE_RECORD_NUDGE=0` disables it independently of recall and Stop settings.

The CLI atomically claims a SHA-256 hash of the transcript path and last user boundary in SQLite metadata before emitting the reminder. Duplicate hook processes cannot both claim the same turn. Including the user boundary's line offset distinguishes repeated identical requests in one transcript. Only the hash is persisted, never the prompt or transcript text. A hook crash after claiming can lose that optional reminder, which is preferable to reopening a final answer or repeatedly nagging. These markers are local metadata and are not exported as experiences.

**Stop** (the turn is ending): silent by default. The CLI returns before opening the catalogue, and the hook does not read the transcript. Optional bookkeeping must not interrupt answer delivery: in Codex, a blocking Stop response starts a continuation that can replace the substantive final answer. Only an explicit `LEARNED_EXPERIENCE_STOP_NUDGE=1` (or `stopNudge: true` for direct callers) enables the legacy reminder. When enabled, the hook reads the transcript, isolates the last turn (from the last human message), and counts tool calls, failed tool results, and calls to learned-experience's own `record`, `reinforce`, and `recall`. If nothing was recorded and the turn was eventful (at least one failure across three or more calls, or fifteen or more calls), it returns `decision: "block"` with a reason asking the model to `record` once, or `reinforce` if it applied a recalled fix, or stop if nothing is worth keeping. Claude Code sets `stop_hook_active` on the retry, and the hook returns nothing then, so it asks at most once per turn.

Everything the hooks do before the lookup is deterministic string processing. They never fail loudly: any error is logged to stderr and the session continues.

**Gemini CLI** uses the same shapes under different names: `AfterTool` behaves like Codex's `PostToolUse`, `BeforeAgent` like `UserPromptSubmit`. Gemini reads `additionalContext` at the top level of the hook's output, so the hook emits it both there and under `hookSpecificOutput`. Gemini has no end-of-turn event with a transcript, so the record reminder is not available there.

**Setup is automated** by `learned-experience install` (`src/install.ts`). It detects hosts by their config directories or CLIs, registers the server (through `claude mcp add` and `codex mcp add` where those CLIs exist, otherwise by editing the host's JSON or TOML), merges hooks into the host's hook file without touching entries it did not write, backs up every file it changes, and is idempotent. `--dry-run` reports the plan. `uninstall` reverses it. The plugin (`plugin/`) remains the Claude Code-native alternative; the repository root carries a `marketplace.json` so `claude plugin marketplace add fitz2882/learned-experience` works.

## What is deliberately not here

- No LLM calls inside the server. Summarisation, generalisation, and judgment stay with the agent.
- No cloud dependency for the core loop.
- No free-text memory. The schema is the product; a general memory store is a different tool.

## Future work

- Optional secondary embedding model for reranking.
- Hooks for other hosts as they gain hook support.
- A WikiSkill-style compiler that turns `rule` records into SKILL.md files.
