# learned-experience

**A memory of solved problems for AI agents.** Any agent that speaks MCP can check it before working, apply what worked last time, report whether it worked, and record new lessons. Nothing has to be learned twice, and the catalogue travels with you across models, tools, and machines.

- **Works with any MCP host**: Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI, Gemini CLI, or anything built on an MCP client. The server, tools, and data are identical everywhere.
- **One-command setup**: `npx -y learned-experience install` detects your agents and configures each one.
- **Automatic in Claude Code, Codex, and Gemini CLI**: hooks make recall and recording happen without the model having to remember.
- **Your data, in one file**: a SQLite database you own, plus a small embedding model that runs on your machine. No account, no API key, nothing sent anywhere. Sync the file, export it, or serve it over HTTP to carry it between machines.
- **Deterministic where it matters**: exact error fingerprints, lexical search, fixed-weight fusion, Bayesian confidence.
- **Self-improving**: outcomes feed back into ranking, and duplicates are merged instead of stored twice.
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

Both plugin systems check the marketplace for new versions in the background and pick up a release when its version number changes. To force it: `claude plugin update learned-experience` or `codex plugin marketplace upgrade`.

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

The MCP server, its eight tools, the record format, the search, and the database are the same on every host and with every model. Nothing in them knows which agent is calling. That is the part that makes the catalogue portable across providers.

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
| `confidence` | Derived from real outcomes: `(successes + 1) / (uses + 2)` |

The loop the agent runs:

1. **Recall** before working. Exact signal matches are found without any model. Similar problems are found by combining local embeddings with lexical search.
2. **Apply** the best fix, respecting the avoid-list.
3. **Reinforce**: report whether it worked. This is what makes ranking improve over time.
4. **Record** anything non-trivial once solved. Duplicates are merged automatically, and the same symptom with a different fix is linked rather than duplicated.
5. **Dismiss** a hit that did not apply. The record is never recalled for that query again, and its fuzzy matches are damped everywhere, so false positives fade instead of repeating.

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
| `reinforce` | Report whether a recalled fix worked. Failure notes go on the avoid-list. |
| `dismiss` | Report that a recalled record did not apply to the problem. Suppresses it for that query and damps its fuzzy matches. |
| `amend` | Patch fields of an existing record. |
| `forget` | Delete a record. |
| `consolidate` | Cluster similar episodes so the agent can write one generalised `rule`. |
| `stats` | Counts, success rate, duplicates prevented, embedding status. |
| `transfer` | Export or import JSONL. |

Resource `learned-experience://protocol` and prompt `solve` carry the same protocol text the server sends as instructions.

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
