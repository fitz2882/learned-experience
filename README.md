# learned-experience

**A memory of solved problems for AI agents.** Any agent that speaks MCP can check it before working, apply what worked last time, report whether it worked, and record new lessons. Nothing has to be learned twice, and the catalogue travels with you across models, tools, and machines.

- **Works with any MCP host**: Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI, Gemini CLI, or anything built on an MCP client. The server, tools, and data are identical everywhere.
- **One-command setup**: `npx -y learned-experience install` detects your agents and configures each one.
- **Automatic in Claude Code, Codex, and Gemini CLI**: hooks make recall and recording happen without the model having to remember.
- **Your data, in one file**: a SQLite database you own, plus a small embedding model that runs on your machine. No account, no API key, nothing sent anywhere. Sync the file, export it, or serve it over HTTP to carry it between machines.
- **Deterministic where it matters**: exact error fingerprints, lexical search, fixed-weight fusion, Bayesian confidence.
- **Evidence-based ranking**: independent verification reports improve ranking for the exact lesson revision; diagnostics and legacy feedback stay separate.
- **Portable**: JSONL export and import, with secrets redacted and paths made machine-independent.

## Quick start

Requires Node 22.13 or newer.

```bash
npx -y learned-experience install
```

That detects the agents on your machine and configures each one: the MCP server everywhere, plus hooks where the host supports them. It is safe to re-run, backs up every file it touches (`<file>.bak`), never removes anything that is not its own, and `--dry-run` shows the plan without writing. Then restart the agents. The first use downloads a 23 MB embedding model into `~/.learned-experience/models`, after which everything runs offline.

| Host | What `install` does | What you still do |
|---|---|---|
| Claude Code | Registers the server with `claude mcp add`, adds failure, after-tool, prompt, and optional Stop hooks to `~/.claude/settings.json`. Skipped if the plugin below is installed. | Restart Claude Code |
| Codex CLI and the Codex desktop app | Registers the server with `codex mcp add`, adds three hooks to `~/.codex/hooks.json`. The desktop app (inside the ChatGPT app) reads the same `~/.codex` configuration. | Run `/hooks` once in Codex to trust them |
| Gemini CLI | Adds the server and two hooks to `~/.gemini/settings.json` | Nothing |
| OpenClaw | Adds the server under `mcp.servers` in `~/.openclaw/openclaw.json` (or via `openclaw mcp add` when the file uses JSON5 syntax) | Restart the gateway. OpenClaw hooks are in-process plugins, not shell commands, so the model follows the protocol from MCP instructions. |
| Cursor | Adds the server to `~/.cursor/mcp.json` | No hooks exist, so paste the reminder from [Hosts without hooks](#hosts-without-hooks) into your Cursor rules |
| Windsurf | Adds the server to `~/.codeium/windsurf/mcp_config.json` | Same: paste the reminder from [Hosts without hooks](#hosts-without-hooks) into your global rules |
| Claude Desktop | Adds the server to `claude_desktop_config.json` | Restart Claude Desktop |

Pick hosts explicitly with `install codex gemini`, remove everything with `uninstall`, and use `--local` when running from a clone so hosts launch your build instead of the npm package.

**Plugins** (alternative to the installer; same result, managed by the host's plugin system, updated when a new version is published):

```bash
# Claude Code
claude plugin marketplace add fitz2882/learned-experience
claude plugin install learned-experience@learned-experience

# Codex CLI and desktop app
codex plugin marketplace add fitz2882/learned-experience
codex plugin add learned-experience
```

The marketplace plugins pin their server and hook commands to the matching npm release. To update Claude Code, run `claude plugin marketplace update learned-experience` followed by `claude plugin update learned-experience@learned-experience`. For Codex, run `codex plugin marketplace upgrade learned-experience` followed by `codex plugin add learned-experience@learned-experience`. Restart existing host sessions after updating.

**One catalogue for all of them.** Every host launches the same server, and the server reads the same database, so a lesson recorded in Codex is recalled in Claude Code, Gemini, Cursor, or OpenClaw, and vice versa.

**Any other MCP host**, by hand:

```json
{
  "mcpServers": {
    "learned-experience": {
      "command": "npx",
      "args": ["-y", "learned-experience"]
    }
  }
}
```

## What is universal and what is per host

The MCP server, its tools, the record format, the search, and the database are the same on every host and with every model. Nothing in them knows which agent is calling. That is the part that makes the catalogue portable across providers.

Hooks are not part of MCP. Each host decides whether it has hooks, which events exist, and what the payloads look like. Claude Code has a dedicated tool-failure event. Codex and Gemini CLI only have a general after-tool event, so the hook checks the response for signs of failure itself. OpenClaw's hooks are in-process TypeScript plugins rather than shell commands. Cursor, Windsurf, and Claude Desktop have no hooks at all. The single `learned-experience hook` command understands every dialect it has been taught (Claude Code, Codex, Gemini CLI), and hosts without hooks fall back to the protocol the server sends as MCP instructions, which every host injects into the model's context.

## How it works

Every record is a compact, standardised lesson:

| Field | Meaning |
|---|---|
| `problem` | One generic line: what went wrong or what was hard |
| `signals` | Exact error text, failing command, or symptom. This is the deterministic key. |
| `context` | Tags: language, framework, tool, OS |
| `fix` | What worked, concrete enough to repeat |
| `avoid` | What did not work, or made it worse |
| `root_cause` | Why it happened, if known |
| `outcome` | `success`, `partial`, or `failure`. Dead ends are worth recording too. |
| `confidence` | Smoothed rate from matching, revision-bound verification reports; not an external attestation |

The loop the agent runs:

1. **Recall** before working. Exact signal matches are found without any model. Similar problems are found by combining local embeddings with lexical search.
2. **Apply** the best fix, respecting the avoid-list.
3. **Verify**: call `begin_attempt` before trying a fix, then `feedback` with a checked result, environment and evidence. Repeated observers of one execution count once. Legacy `reinforce` remains supported as unverified feedback.
4. **Record** anything non-trivial once solved. Duplicates are merged automatically, and the same symptom with a different fix is linked rather than duplicated.
5. **Dismiss** a hit that did not apply, or report `irrelevant` feedback with its query and environment. This affects matching for that context; it does not downvote a fix you never tried.

It learns from anything the agent records, not just tool errors: tricky refactors, surprising library behaviour, build configuration, design choices that turned out badly.

## What the hooks do

MCP cannot see a model's reasoning, so without hooks the model has to remember to use the catalogue. Hooks remove that dependency. They all run the same command, `learned-experience hook`, which dispatches on the host's event name:

| Moment | Claude Code | Codex | Gemini CLI | What happens |
|---|---|---|---|---|
| **A tool call fails** | `PostToolUseFailure` | `PostToolUse` | `AfterTool` | The error text becomes a query. Matching fixes are injected with the instruction to apply one and `reinforce`. On a miss, a one-line reminder to `record` once solved. Codex and Gemini have no failure event, so the hook runs after every tool call and acts only when the response carries a non-zero exit code, an error flag, or unmistakable failure text. |
| **You send a request** | `UserPromptSubmit` | `UserPromptSubmit` | `BeforeAgent` | The request becomes a query. If past experience looks relevant it is injected before the model starts. Silent otherwise; skipped for short prompts and slash commands. |
| **Work becomes substantial** | `PostToolUse` | `PostToolUse` | no transcript-based reminder yet | After a successful tool call, the hook checks the current transcript. After a failure across at least three calls, or fifteen calls without failures, it sends one non-blocking reminder to record a verified lesson before the final answer. No extra model run is started. |
| **The turn ends** | `Stop` | `Stop` | not available | Silent by default so the final answer is delivered without a housekeeping continuation. Explicitly setting `LEARNED_EXPERIENCE_STOP_NUDGE=1` enables the legacy blocking reminder after eventful turns; its loop guard still applies. |

What the model sees after a failure:

```
learned-experience: 1 past experience matches this failure.
1. [x_9f1c2a4b] Global npm install fails with EACCES | fix: npm config set prefix ~/.npm-global … | avoid: sudo npm install -g | (confidence 0.8, exact match)
Apply the best-fitting fix first, then call learned-experience `reinforce` with its id and whether it worked. If none fit and you solve it another way, call `record` once.
```

Failures caused by you (interrupts, permission denials) and failures of learned-experience's own tools are ignored, so the hooks cannot loop.

`install` writes these for you. By hand, the Claude Code shape in `~/.claude/settings.json` is:

```json
{
  "hooks": {
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "npx -y learned-experience hook", "timeout": 30 }] }],
    "PostToolUse":         [{ "hooks": [{ "type": "command", "command": "npx -y learned-experience hook", "timeout": 30 }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "npx -y learned-experience hook", "timeout": 20 }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "npx -y learned-experience hook", "timeout": 20 }] }]
  }
}
```

Codex uses the same shape in `~/.codex/hooks.json` with `PostToolUse` (see [examples/codex-hooks.json](examples/codex-hooks.json)). Gemini CLI uses `hooks` inside `~/.gemini/settings.json` with `AfterTool` and `BeforeAgent`, timeouts in milliseconds, and a `name` on each hook.

Existing installations running an older npm version can disable the reminder immediately by changing only the Stop command to `LEARNED_EXPERIENCE_STOP_NUDGE=0 npx -y learned-experience hook` in their hook configuration (POSIX shells). Keep the failure and prompt hooks enabled; they provide recall and recording guidance during the work. No stored experiences need to change.

Recording reminders are **on by default during work**. They are attached as tool context, not a new user request. The agent can record a useful lesson or skip trivia, then deliver the original answer. The reminder is advisory, so it does not guarantee that every lesson is recorded. Failure recall and prompt recall remain enabled independently.

The transcript-based reminder currently understands Claude Code and Codex JSONL. It stays silent if the transcript is missing or unrecognized, a direct `record`/`reinforce` call is already present, or a Codex final answer has been written. One hashed marker per reminded turn is stored atomically in local SQLite metadata to prevent duplicate reminders across hook processes; prompt and transcript text are not stored in these markers. Hosts without a supported transcript still receive the existing failure-time recording guidance. Existing Claude Code installs should rerun `learned-experience install claude-code` (or update the plugin) to add the successful `PostToolUse` hook. Codex already registers it.

### Hosts without hooks

Cursor, Windsurf, Claude Desktop, and OpenClaw cannot run these shell hooks, so there the model has to remember to use the catalogue. The server sends its protocol as MCP instructions, which these hosts inject into the model's context, and a short standing reminder in the host's rules makes it reliable. Paste this into Cursor's rules, Windsurf's global rules, `CLAUDE.md`, or `AGENTS.md`:

```
Before investigating any error or failing command, call the learned-experience `recall` tool with the exact error text in `signals`.
After applying a recalled fix, call `reinforce` with the result. After solving something non-trivial, call `record` once.
```

## Tools

| Tool | Purpose |
|---|---|
| `recall` | Has this problem, or a similar one, been solved before? Returns ranked hits with fix, avoid-list, and confidence. |
| `record` | Store a lesson. Merges or links duplicates automatically. |
| `begin_attempt` | Bind a planned application to a revision, execution identity and environment. |
| `feedback` | Report verified success/failure, diagnostic help, relevance, or uncertainty. |
| `reinforce` | Legacy reported outcome; does not create verified votes. |
| `dismiss` | Report that a recalled record did not apply to the problem. Suppresses it for that query and damps its fuzzy matches. |
| `amend` | Patch fields of an existing record. |
| `forget` | Delete a record. |
| `consolidate` | Cluster similar episodes so the agent can write one generalised `rule`. |
| `inspect` | Full lesson, current revision, evidence, votes and prior snapshots. |
| `maintenance` | Run bounded checks, inspect the durable queue, or resolve an item with evidence. |
| `restore` | Restore historical content/state with a revision guard and audit trail. |
| `stats` | Legacy counters, verification coverage, checked outcomes, queue size and embedding health. |
| `transfer` | Export or import JSONL. |

Resource `learned-experience://protocol` and prompt `solve` carry the same protocol text the server sends as instructions.

## Verification votes and ongoing maintenance (0.4)

A vote means an agent applied a particular revision and checked the result. `begin_attempt` takes a stable `execution_id` from the actual run/test; all observers of that same execution must reuse it. Pass its returned `id`, `revision`, `attempt_id` and `environment` to `feedback`, with one of:

- `verified-success` or `verified-failure`: requires a nonempty fix, all applicability constraints matched, and evidence `{summary, reference, observed_at, level}`. `level` must be `local-test` or `target-environment`.
- `diagnostic-help`, `relevant`, `irrelevant` or `unverified`: never increments solution verification counts. Irrelevant feedback requires the actual query.

The server deduplicates execution identities atomically across hosts. It does not attest that a model told the truth or that two invented identities represent independent runs. Host agents must use genuine run identities and evidence. Agreement alone is not a vote. A changed remedy, scope or precondition changes the revision; old votes stay in history and cannot boost the new version. Empty/partial fixes are returned as diagnostic leads regardless of old positive feedback.

Use optional `applicability` for exact `product`, `version`, `platform` and `project` constraints, and `preconditions` for checks the agent must perform. Versions are exact strings, not semver ranges. Tags remain search hints. Missing applicability information is shown as unknown; explicit mismatches are excluded even for an exact error match. Put temporary deployment status in dated `observations`. Optional `claims: [{key, value}]` makes conflicting scoped facts mechanically detectable.

The running MCP server starts a local maintenance sweep on startup and every five minutes. Multiple hosts share an interval lease. Each pass visits at most 20 records with a 100 ms soft processing budget; it uses a persisted cursor and queue. No new infrastructure, network model calls or commands from lessons are used. `record` also runs a small bounded pass. Short-lived hooks never start the worker, and Stop stays silent.

Checks queue incomplete fixes, temporary status, unverified version-specific advice, failed verifications, possible duplicate pairs, explicit conflicting claims and corrections embedded in merged reports. Queue entries are revision-bound. A semantic resemblance creates a review candidate, not permission to merge. The host agent is instructed to handle at most one relevant review during normal work when it has evidence; uncertain items remain pending. Thus detection is automatic, while semantic correction depends on an active, cooperating agent with source/test access. The server does not pretend a queue alone proves correctness.

`maintenance(mode="resolve")` accepts checked evidence. `supersede` and `consolidate` take an optional `winner_id` selecting either record in a pair (default: `related_id`). Superseded records disappear from ordinary recommendations; reviewed duplicates share one result slot without deleting observations or combining votes. `accept-candidate` applies the exact queued correction. Inspect its history first. `dismiss` closes an inapplicable review item. Use `amend` with `expected_revision` to make other evidence-backed corrections, or `restore` to undo them. Stored text is untrusted data; reviewers must not execute commands merely because a lesson suggests them.

For maintenance while no MCP host is running:

```bash
learned-experience maintenance          # one bounded sweep and queue report
learned-experience maintenance --watch  # foreground worker, five-minute interval
```

**Upgrading:** back up the SQLite database (or export it) and upgrade all writers together. Existing v1 records load without fabricated votes or verification. Legacy `reinforce` calls and counters remain available, but recall reliability now uses verification reports. Votes and history travel in JSONL. Different imported content becomes a review candidate; independent votes are unioned by identity. Older binaries do not understand these extensions and must not write to an upgraded catalogue. `npm`/marketplace publication and host restart are separate from building this checkout.

## Command line

Useful for scripts, other hosts, or just looking at what you have:

```bash
npx -y learned-experience install --dry-run          # show what setup would change
npx -y learned-experience install codex gemini       # set up specific hosts
npx -y learned-experience uninstall                  # remove everything it added
npx -y learned-experience recall "postgres connection refused"
npx -y learned-experience stats
npx -y learned-experience export backup.jsonl
npx -y learned-experience import backup.jsonl
npx -y learned-experience --http --port 3111      # streamable HTTP at http://127.0.0.1:3111/mcp
```

HTTP mode is for hosts that want a URL, or for sharing one catalogue across machines (see below).

## Taking it with you

"Local" means the data is yours and nothing phones home. It does not mean the catalogue is stuck on one machine. Everything lives in one file, `~/.learned-experience/experiences.db`, and there are three ways to carry it:

1. **Sync the folder.** Point `LEARNED_EXPERIENCE_HOME` at a directory in iCloud Drive, Dropbox, Syncthing, or a git repo, on every machine. Simplest, and fine when one machine at a time is writing. Two machines writing at the same moment through a file-sync service can conflict, as with any SQLite file; if that is your situation, use option 3.
2. **Export and import.** `export` writes JSONL, `import` merges it. Import is idempotent: importing the same file twice changes nothing. Embeddings are not exported; the destination recomputes them with its own model. Good for hand-offs, backups, and sharing a catalogue with a teammate.
3. **Serve it.** Run `npx -y learned-experience --http` on one machine (or a small VPS) and point the other hosts at the URL. One catalogue, many agents, no sync at all. Put it behind your own auth before exposing it beyond localhost.

On a single machine, several agents can share the database at once. Each server picks up the others' writes.

## Configuration

All optional.

| Variable | Default | Meaning |
|---|---|---|
| `LEARNED_EXPERIENCE_HOME` | `~/.learned-experience` | Data directory |
| `LEARNED_EXPERIENCE_DB` | `$HOME_DIR/experiences.db` | Database path |
| `LEARNED_EXPERIENCE_TRANSFER_DIR` | `$HOME_DIR/transfers` | The only directory the `transfer` tool may touch |
| `LEARNED_EXPERIENCE_EMBEDDINGS` | `local` | `local`, `openai`, `ollama`, or `none` (lexical only) |
| `LEARNED_EXPERIENCE_EMBED_MODEL` | per provider | `Xenova/all-MiniLM-L6-v2`, `text-embedding-3-small`, `nomic-embed-text` |
| `LEARNED_EXPERIENCE_EMBED_BASE_URL` | per provider | Any OpenAI-compatible endpoint, or the Ollama base URL |
| `LEARNED_EXPERIENCE_EMBED_API_KEY` | `$OPENAI_API_KEY` | Key for remote providers |
| `LEARNED_EXPERIENCE_MAINTENANCE` | `1` | `0`: disable the automatic local maintenance timer; explicit maintenance tools still work |
| `LEARNED_EXPERIENCE_HOOK_QUIET` | unset | `1`: no reminder after a failure that matches nothing |
| `LEARNED_EXPERIENCE_RECORD_NUDGE` | `1` | `0`: disable the non-blocking recording reminder during work |
| `LEARNED_EXPERIENCE_RECORD_MIN_FAILURES` | `1` | Failures needed for the during-work reminder |
| `LEARNED_EXPERIENCE_RECORD_MIN_CALLS` | `3` | Tool calls needed alongside those failures |
| `LEARNED_EXPERIENCE_RECORD_LONG_TURN` | `15` | Tool calls that qualify even without failures |
| `LEARNED_EXPERIENCE_STOP_NUDGE` | `0` | Only `1` opts in to a blocking end-of-turn reminder. Leave disabled in Codex: a continuation can replace the final answer. |
| `LEARNED_EXPERIENCE_STOP_MIN_FAILURES` | `1` | Failed tool calls needed before the end-of-turn reminder |
| `LEARNED_EXPERIENCE_STOP_MIN_CALLS` | `3` | Tool calls needed before the end-of-turn reminder |
| `LEARNED_EXPERIENCE_STOP_LONG_TURN` | `15` | Tool calls after which the reminder fires even without failures |

Changing the embedding model is safe. Stored vectors are tagged with the model id, and stale ones are recomputed at startup.

## Privacy

Records are meant to travel, so every string is cleaned on write: API keys, tokens, JWTs, bearer headers, `key=value` secrets, emails, and URL credentials are redacted, and home directories become `~`. Nothing leaves your machine unless you choose a remote embedding provider or export a file.

## Development

```bash
npm install
npm test          # vitest, in-memory database, deterministic fake embedder
npm run typecheck
npm run quality   # real-model MCP voting, correction, abstention and hook replay in an isolated database
npm run smoke     # builds, then drives the real server over stdio with the real local model
```

Design rationale, the retrieval fusion, and the dedup rules are in [DESIGN.md](DESIGN.md).

## License

MIT

### Temporary dependency security pins

Repository installs pin `adm-zip` to 0.6.0 under `onnxruntime-node` and `sharp`
to 0.35.0 under `@huggingface/transformers` to address GHSA-xcpc-8h2w-3j85
and GHSA-f88m-g3jw-g9cj. The parent packages currently request older ranges.
The offline suite checks the actual ZIP extraction and Transformers image APIs
against these patched versions; no model downloads are needed for those tests.

These npm overrides protect installs made from this repository as the install
root. npm ignores dependency-owned overrides when this package is installed
through another project or `npx`; this change alone does **not** remediate the
published package. Before a release claims these fixes, update the upstream
ranges or adopt and verify a published dependency-locking strategy with an
isolated consumer-install test. See [npm override semantics](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides).

Codex hook commands use `learned-experience hook --codex` to emit schema-compatible context only in `hookSpecificOutput.additionalContext`. Existing registrations with Codex’s `turn_id` payload are detected automatically. Claude Code and Gemini retain their existing output format.
