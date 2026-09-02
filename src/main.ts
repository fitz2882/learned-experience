/**
 * Main entry (loaded by index.ts after the warning filter is installed).
 *   experience-mcp                 stdio transport (what every MCP host speaks)
 *   experience-mcp --http [--port 3111] [--host 127.0.0.1]   streamable HTTP transport
 *   experience-mcp export <file>   dump the catalogue as JSONL without an agent
 *   experience-mcp import <file>   merge a JSONL file into the catalogue
 *
 * Environment:
 *   EXPERIENCE_HOME     data directory (default ~/.experience-mcp)
 *   EXPERIENCE_DB       explicit database path (overrides EXPERIENCE_HOME/experiences.db)
 *   EXPERIENCE_EMBEDDINGS, EXPERIENCE_EMBED_MODEL, EXPERIENCE_EMBED_BASE_URL, EXPERIENCE_EMBED_API_KEY
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Catalogue } from "./catalogue.js";
import { createEmbedder, embedderConfigFromEnv } from "./embed/index.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

function log(msg: string): void {
  process.stderr.write(`[experience-mcp] ${msg}\n`);
}

function parseArgs(argv: string[]) {
  const args = { http: false, port: 3111, host: "127.0.0.1", command: null as null | "export" | "import", file: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--host") args.host = argv[++i];
    else if (a === "export" || a === "import") {
      args.command = a;
      args.file = argv[++i] ?? "";
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: experience-mcp [--http [--port N] [--host H]] | export <file> | import <file>\n"
      );
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const home = process.env.EXPERIENCE_HOME ?? join(homedir(), ".experience-mcp");
  const dbPath = process.env.EXPERIENCE_DB ?? join(home, "experiences.db");
  const transferDir = process.env.EXPERIENCE_TRANSFER_DIR ?? join(home, "transfers");

  const store = new Store(dbPath);
  const embedder = await createEmbedder(embedderConfigFromEnv(process.env, join(home, "models")));
  const catalogue = new Catalogue(store, embedder);

  if (args.command === "export") {
    if (!args.file) throw new Error("export needs a file path");
    await catalogue.init();
    const text = await catalogue.exportJsonl();
    await writeFile(args.file, text + (text ? "\n" : ""), "utf8");
    log(`exported ${store.count()} records to ${args.file}`);
    return;
  }
  if (args.command === "import") {
    if (!args.file) throw new Error("import needs a file path");
    await catalogue.init();
    const result = await catalogue.importJsonl(await readFile(args.file, "utf8"));
    log(`import: ${JSON.stringify(result)}`);
    return;
  }

  // Warm the indexes (and the local model) in the background so the first recall is fast.
  catalogue.init().then(
    () => log(`ready: ${store.count()} records, embeddings=${embedder?.id ?? "none"}, db=${dbPath}`),
    (e) => log(`init failed: ${e instanceof Error ? e.message : String(e)}`)
  );

  if (args.http) {
    const httpServer = createHttpServer((req, res) => {
      handleHttp(req, res).catch((e) => {
        log(`http request failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) res.writeHead(e instanceof SyntaxError ? 400 : 500, { "content-type": "application/json" });
        if (!res.writableEnded) res.end(JSON.stringify({ error: e instanceof SyntaxError ? "invalid JSON body" : "internal error" }));
      });
    });
    const handleHttp = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      // Stateless: one server + transport per request, sharing the same catalogue.
      const server = buildServer(catalogue, { transferDir });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      let body: unknown = undefined;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        body = raw ? JSON.parse(raw) : undefined;
      }
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    };
    httpServer.listen(args.port, args.host, () => log(`http listening on http://${args.host}:${args.port}/mcp`));
    return;
  }

  const server = buildServer(catalogue, { transferDir });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
