# experience-mcp

A model-agnostic MCP server that gives any AI agent a persistent catalogue of problems it has solved before. The agent checks it when something goes wrong, applies what worked last time, reports whether it worked, and records new lessons. Nothing has to be learned twice, and the catalogue travels with you across models, tools, and machines.

- **Works with any MCP host**: Claude Code, Claude Desktop, Cursor, Windsurf, Codex CLI, Gemini CLI, LangGraph, or anything built on an MCP client.
- **Deterministic where it matters**: exact error fingerprints, BM25 lexical search, fixed-weight fusion, Bayesian confidence. The only model in the loop is a small local embedding model, pinned by id.
- **Local and offline by default**: one SQLite file, embeddings computed on-device through ONNX. No API key needed. Remote embedding providers are opt-in.
- **Self-improving**: `reinforce` feeds real outcomes back into ranking. `record` merges duplicates instead of storing them twice.
- **Portable**: JSONL export and import with secret redaction and machine-independent paths.

Design rationale and the record schema are in [DESIGN.md](DESIGN.md).

## Install

Requires Node 22.13 or newer.

```bash
npm install
npm run build
```

The first `recall` or `record` downloads the embedding model (about 23 MB) into `~/.experience-mcp/models`. After that it runs offline.

## Connect an agent

**Claude Code**

```bash
claude mcp add --scope user experience -- node "/absolute/path/to/experience-mcp/dist/index.js"
```

**Claude Desktop, Cursor, Windsurf** (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.)

```json
{
  "mcpServers": {
    "experience": {
      "command": "node",
      "args": ["/absolute/path/to/experience-mcp/dist/index.js"]
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.experience]
command = "node"
args = ["/absolute/path/to/experience-mcp/dist/index.js"]
```

**HTTP** for hosts that want a URL, or to share one catalogue across machines:

```bash
node dist/index.js --http --port 3111
```

The endpoint is `http://127.0.0.1:3111/mcp`. Put it behind your own auth before exposing it beyond localhost.

## Make the agent use it

The server sends its protocol to the host as MCP `instructions`, which most hosts inject into the model's context. Hosts with rule files benefit from a reminder. Add this to `CLAUDE.md`, `AGENTS.md`, or `.cursorrules`:

```
Before investigating any error or failing command, call experience.recall with the exact error text in `signals`.
After applying a recalled fix, call experience.reinforce with the result. After solving something non-trivial, call experience.record once.
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

Resource `experience://protocol` and prompt `solve` carry the same protocol text.

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
| `EXPERIENCE_HOME` | `~/.experience-mcp` | Data directory (database and model cache) |
| `EXPERIENCE_DB` | `$EXPERIENCE_HOME/experiences.db` | Explicit database path |
| `EXPERIENCE_TRANSFER_DIR` | `$EXPERIENCE_HOME/transfers` | The only directory the `transfer` tool may read or write `.jsonl` files in |
| `EXPERIENCE_EMBEDDINGS` | `local` | `local`, `openai`, `ollama`, or `none` (lexical only) |
| `EXPERIENCE_EMBED_MODEL` | provider default | `Xenova/all-MiniLM-L6-v2`, `text-embedding-3-small`, `nomic-embed-text` |
| `EXPERIENCE_EMBED_BASE_URL` | provider default | Any OpenAI-compatible endpoint, or the Ollama base URL |
| `EXPERIENCE_EMBED_API_KEY` | `$OPENAI_API_KEY` | Key for remote providers |

Changing the embedding model is safe. Stored vectors are tagged with the model id, and stale ones are recomputed at startup.

## Moving the catalogue

Copy `~/.experience-mcp/experiences.db` to another machine, or use JSONL:

```bash
node dist/index.js export experiences.jsonl
node dist/index.js import experiences.jsonl
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
