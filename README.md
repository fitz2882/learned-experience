# learned-experience

**A memory of solved problems for AI agents.** Any agent that speaks MCP can check it before working, apply what worked last time, report whether it worked, and record new lessons. Nothing has to be learned twice, and the catalogue travels with you across models, tools, and machines.

- **Works with any MCP host**: Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI, Gemini CLI, or anything built on an MCP client.
- **Automatic in Claude Code**: three hooks make recall and recording happen without the model having to remember.
- **Local, offline, no API key**: one SQLite file and a small embedding model that runs on your machine.
- **Deterministic where it matters**: exact error fingerprints, lexical search, fixed-weight fusion, Bayesian confidence.
- **Self-improving**: outcomes feed back into ranking, and duplicates are merged instead of stored twice.
- **Portable**: JSONL export and import, with secrets redacted and paths made machine-independent.

## Quick start

Requires Node 22.13 or newer.

**Claude Code** (server plus hooks, one install):

```bash
claude plugin marketplace add fitz2882/learned-experience
claude plugin install learned-experience@learned-experience
```

Restart Claude Code. That's it. The first use downloads a 23 MB embedding model into `~/.learned-experience/models`, then everything runs offline.

**Any other MCP host** (server only), for example Claude Desktop, Cursor, or Windsurf:

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

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.learned-experience]
command = "npx"
args = ["-y", "learned-experience"]
```

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

It learns from anything the agent records, not just tool errors: tricky refactors, surprising library behaviour, build configuration, design choices that turned out badly.

## What the Claude Code hooks do

MCP cannot see a model's reasoning, so on most hosts the model has to remember to use the catalogue. In Claude Code the plugin removes that dependency with three hooks, all running the same command, `learned-experience hook`:

| Event | What happens |
|---|---|
| **A tool call fails** | The error text is turned into a query and matching fixes are injected into context, with the instruction to apply one and `reinforce`. On a miss, a one-line reminder to `record` once solved. |
| **You send a request** | The request is used as a query. If past experience looks relevant, it is injected before the model starts. Silent otherwise, and skipped for short prompts and slash commands. |
| **The turn ends** | If the turn had failed tool calls (or was very long) and nothing was recorded, the model is asked once whether something is worth recording. It never asks twice in a turn, and never fires after a `record` or `reinforce`. |

What the model sees after a failure:

```
learned-experience: 1 past experience matches this failure.
1. [x_9f1c2a4b] Global npm install fails with EACCES | fix: npm config set prefix ~/.npm-global … | avoid: sudo npm install -g | (confidence 0.8, exact match)
Apply the best-fitting fix first, then call learned-experience `reinforce` with its id and whether it worked. If none fit and you solve it another way, call `record` once.
```

Failures caused by you (interrupts, permission denials) and failures of learned-experience's own tools are ignored, so the hooks cannot loop.

Without the plugin, the same hooks can be added to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "npx -y learned-experience hook", "timeout": 30 }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "npx -y learned-experience hook", "timeout": 20 }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "npx -y learned-experience hook", "timeout": 20 }] }]
  }
}
```

For hosts without hooks, the server sends its protocol as MCP instructions, which most hosts inject into the model's context. A two-line reminder in `CLAUDE.md`, `AGENTS.md`, or `.cursorrules` helps:

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
| `amend` | Patch fields of an existing record. |
| `forget` | Delete a record. |
| `consolidate` | Cluster similar episodes so the agent can write one generalised `rule`. |
| `stats` | Counts, success rate, duplicates prevented, embedding status. |
| `transfer` | Export or import JSONL. |

Resource `learned-experience://protocol` and prompt `solve` carry the same protocol text the server sends as instructions.

## Command line

Useful for scripts, other hosts, or just looking at what you have:

```bash
npx -y learned-experience recall "postgres connection refused"
npx -y learned-experience stats
npx -y learned-experience export backup.jsonl
npx -y learned-experience import backup.jsonl
npx -y learned-experience --http --port 3111      # streamable HTTP at http://127.0.0.1:3111/mcp
```

The HTTP mode is for hosts that want a URL, or for sharing one catalogue across machines. Put it behind your own auth before exposing it beyond localhost.

## Moving the catalogue

Everything lives in `~/.learned-experience/experiences.db`. Copy that file to another machine, or use `export` and `import`. Import merges rather than overwrites and is idempotent: importing the same file twice changes nothing. Embeddings are not exported; the destination recomputes them with its own model.

Several agents can share one database at the same time. Each server picks up the others' writes.

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
| `LEARNED_EXPERIENCE_STOP_NUDGE` | `1` | `0`: never ask for a record at the end of a turn |
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
