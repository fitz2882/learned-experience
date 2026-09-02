# learned-experience

A model-agnostic MCP server that gives any AI agent a persistent catalogue of problems it has solved before. The agent checks it when something goes wrong, applies what worked last time, reports whether it worked, and records new lessons. Nothing has to be learned twice, and the catalogue travels with you across models, tools, and machines.

- **Works with any MCP host**: Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI, Gemini CLI, LangGraph, or anything built on an MCP client.
- **Deterministic where it matters**: exact error fingerprints, BM25 lexical search, fixed-weight fusion, Bayesian confidence. The only model in the loop is a small local embedding model, pinned by id.
- **Local and offline by default**: one SQLite file, embeddings computed on-device through ONNX. No API key needed. Remote embedding providers are opt-in.
- **Self-improving**: `reinforce` feeds real outcomes back into ranking. `record` merges duplicates instead of storing them twice.
- **Portable**: JSONL export and import with secret redaction and machine-independent paths.

Design rationale and the record schema are in [DESIGN.md](DESIGN.md).

## Install

Requires Node 22.13 or newer. The package runs with `npx`, so nothing needs a global install.

The first `recall` or `record` downloads the embedding model (about 23 MB) into `~/.learned-experience/models`. After that it runs offline.

## Connect an agent

**Claude Code, the easy way: the plugin.** It installs the MCP server and a hook that recalls past fixes automatically whenever a tool call fails.

```bash
claude plugin marketplace add fitz2882/learned-experience
claude plugin install learned-experience@learned-experience
```

**Claude Code, server only**

```bash
claude mcp add --scope user learned-experience -- npx -y learned-experience
```

**Claude Desktop, Cursor, Windsurf** (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.)

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

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.learned-experience]
command = "npx"
args = ["-y", "learned-experience"]
```

Running from a clone instead of npm: `npm install && npm run build`, then use `node /absolute/path/to/dist/index.js` in place of `npx -y learned-experience`.

## Automatic recall on failure (Claude Code hook)

MCP cannot see a model's reasoning, so "check memory when something goes wrong" would normally depend on the model remembering to do it. In Claude Code it does not have to. A `PostToolUseFailure` hook runs `learned-experience hook`, which reads the failure payload, extracts the error lines, runs `recall` in-process, and injects the hits into the model's context:

```
learned-experience: 1 past experience matches this failure.
1. [x_9f1c2a4b] Global npm install fails with EACCES | fix: npm config set prefix ~/.npm-global … | avoid: sudo npm install -g | (confidence 0.8, exact match)
Apply the best-fitting fix first, then call learned-experience `reinforce` with its id and whether it worked. If none fit and you solve it another way, call `record` once.
```

When nothing matches it injects a one-line nudge to `record` the solution once found. Set `LEARNED_EXPERIENCE_HOOK_QUIET=1` to silence misses. Failures caused by the user (interrupts, permission denials) and failures of learned-experience's own tools are ignored.

The plugin registers the hook for you. Without the plugin, add it to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUseFailure": [
      { "hooks": [{ "type": "command", "command": "npx -y learned-experience hook", "timeout": 30 }] }
    ]
  }
}
```

Other hosts do not have failure hooks yet. There, the trigger is the protocol text below, which the server sends as MCP instructions.

**HTTP** for hosts that want a URL, or to share one catalogue across machines:

```bash
node dist/index.js --http --port 3111
```

The endpoint is `http://127.0.0.1:3111/mcp`. Put it behind your own auth before exposing it beyond localhost.

## Make the agent use it

The server sends its protocol to the host as MCP `instructions`, which most hosts inject into the model's context. Hosts with rule files benefit from a reminder. Add this to `CLAUDE.md`, `AGENTS.md`, or `.cursorrules`:

```
Before investigating any error or failing command, call the learned-experience `recall` tool with the exact error text in `signals`.
After applying a recalled fix, call `reinforce` with the result. After solving something non-trivial, call `record` once.
```

## Tools

| Tool | Purpose |
|---|---|
| `recall` | Check whether this problem, or a similar one, was solved before. Returns ranked hits with fix, avoid-list, and confidence. |
| `record` | Store a lesson after solving (or failing to solve) a problem. Duplicates are merged or linked automatically. |
| `reinforce` | Report whether a recalled fix worked. Updates confidence, which drives ranking. Failure notes go on the avoid-list. |
| `amend` | Patch fields of an existing record. |
| `forget` | Delete a record. |
| `consolidate` | Return clusters of similar episodes so the agent can write one generalised `rule`. |
| `stats` | Counts, success rate, duplicates prevented, embedding status. |
| `transfer` | Export or import JSONL. |

Resource `learned-experience://protocol` and prompt `solve` carry the same protocol text.

### Example

```jsonc
// recall
{ "problem": "database refusing connections",
  "signals": ["Error: connect ECONNREFUSED 127.0.0.1:5432"],
  "context": ["postgres"] }

// → hits[0]
{ "id": "x_9f1c2a4b7d3e",
  "problem": "App cannot connect to local Postgres",
  "fix": "Start the Postgres service: brew services start postgresql@16",
  "avoid": ["Restarting the app does nothing; the DB is not running"],
  "root_cause": "Postgres service was not running after reboot",
  "context": ["macos", "node", "postgres"],
  "outcome": "success", "confidence": 0.8, "uses": 3,
  "match": { "score": 0.94, "exact": true, "via": ["fingerprint", "lexical", "semantic"] } }
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LEARNED_EXPERIENCE_HOME` | `~/.learned-experience` | Data directory (database and model cache) |
| `LEARNED_EXPERIENCE_DB` | `$LEARNED_EXPERIENCE_HOME/experiences.db` | Explicit database path |
| `LEARNED_EXPERIENCE_TRANSFER_DIR` | `$LEARNED_EXPERIENCE_HOME/transfers` | The only directory the `transfer` tool may read or write `.jsonl` files in |
| `LEARNED_EXPERIENCE_EMBEDDINGS` | `local` | `local`, `openai`, `ollama`, or `none` (lexical only) |
| `LEARNED_EXPERIENCE_EMBED_MODEL` | provider default | `Xenova/all-MiniLM-L6-v2`, `text-embedding-3-small`, `nomic-embed-text` |
| `LEARNED_EXPERIENCE_EMBED_BASE_URL` | provider default | Any OpenAI-compatible endpoint, or the Ollama base URL |
| `LEARNED_EXPERIENCE_EMBED_API_KEY` | `$OPENAI_API_KEY` | Key for remote providers |
| `LEARNED_EXPERIENCE_HOOK_QUIET` | unset | `1` makes the failure hook silent when nothing matches |

Changing the embedding model is safe. Stored vectors are tagged with the model id, and stale ones are recomputed at startup.

## Moving the catalogue

Copy `~/.learned-experience/experiences.db` to another machine, or use JSONL:

```bash
npx -y learned-experience export experiences.jsonl
npx -y learned-experience import experiences.jsonl
```

Import merges rather than overwrites and is idempotent: importing the same file twice changes nothing. The CLI accepts any path; the `transfer` tool an agent calls is confined to the transfer directory so injected instructions cannot turn it into arbitrary file access. Several agents can share one database file at the same time; each server picks up the others' writes.

## Development

```bash
npm test          # vitest, in-memory database, deterministic fake embedder
npm run typecheck
npm run smoke     # builds, then drives the real server over stdio with the real local model
```

## License

MIT
