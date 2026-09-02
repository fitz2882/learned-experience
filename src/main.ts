/**
 * Main entry (loaded by index.ts after the warning filter is installed).
 *   learned-experience                 stdio transport (what every MCP host speaks)
 *   learned-experience --http [--port 3111] [--host 127.0.0.1]   streamable HTTP transport
 *   learned-experience hook            Claude Code hook (PostToolUseFailure, UserPromptSubmit, Stop): payload on stdin, JSON on stdout
 *   learned-experience recall <text>   query the catalogue from a shell; prints JSON hits
 *   learned-experience stats           catalogue statistics as JSON
 *   learned-experience export <file>   dump the catalogue as JSONL without an agent
 *   learned-experience import <file>   merge a JSONL file into the catalogue
 *
 * Environment: see config.ts and hookOptionsFromEnv in hook.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { configFromEnv, openCatalogue } from "./config.js";
import { hookOptionsFromEnv, readStdin, runHook } from "./hook.js";
import { buildServer } from "./server.js";

function log(msg: string): void {
  process.stderr.write(`[learned-experience] ${msg}\n`);
}

type Command = "export" | "import" | "hook" | "recall" | "stats";

function parseArgs(argv: string[]) {
  const args = { http: false, port: 3111, host: "127.0.0.1", command: null as null | Command, file: "", text: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--host") args.host = argv[++i];
    else if (a === "hook" || a === "stats") args.command = a;
    else if (a === "recall") {
      args.command = a;
      args.text = argv.slice(i + 1).join(" ");
      break;
    } else if (a === "export" || a === "import") {
      args.command = a;
      args.file = argv[++i] ?? "";
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: learned-experience [--http [--port N] [--host H]] | hook | recall <text> | stats | export <file> | import <file>\n"
      );
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = configFromEnv();

  if (args.command === "hook") {
    // Never break the user's session: any failure here is logged and swallowed.
    try {
      const payload = JSON.parse(await readStdin()) as Parameters<typeof runHook>[0];
      const { store, catalogue } = await openCatalogue(cfg);
      const out = await runHook(payload, catalogue, hookOptionsFromEnv(process.env));
      store.close();
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (e) {
      log(`hook skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  const { store, catalogue, embedderId } = await openCatalogue(cfg);

  if (args.command === "recall") {
    if (!args.text.trim()) throw new Error("recall needs some text");
    const lines = args.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const res = await catalogue.recall({ problem: lines[0].slice(0, 240), signals: lines.slice(1, 9) });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    store.close();
    return;
  }
  if (args.command === "stats") {
    process.stdout.write(JSON.stringify(await catalogue.stats(), null, 2) + "\n");
    store.close();
    return;
  }

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
    () => log(`ready: ${store.count()} records, embeddings=${embedderId ?? "none"}, db=${cfg.dbPath}`),
    (e) => log(`init failed: ${e instanceof Error ? e.message : String(e)}`)
  );

  const serverOptions = { transferDir: cfg.transferDir };

  if (args.http) {
    const handleHttp = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      // Stateless: one server + transport per request, sharing the same catalogue.
      const server = buildServer(catalogue, serverOptions);
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
    const httpServer = createHttpServer((req, res) => {
      handleHttp(req, res).catch((e) => {
        log(`http request failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) res.writeHead(e instanceof SyntaxError ? 400 : 500, { "content-type": "application/json" });
        if (!res.writableEnded) res.end(JSON.stringify({ error: e instanceof SyntaxError ? "invalid JSON body" : "internal error" }));
      });
    });
    httpServer.listen(args.port, args.host, () => log(`http listening on http://${args.host}:${args.port}/mcp`));
    return;
  }

  const server = buildServer(catalogue, serverOptions);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
