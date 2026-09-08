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
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ALL_HOSTS, formatReport, installHosts, type HostId } from "./install.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { configFromEnv, openCatalogue } from "./config.js";
import { hookOptionsFromEnv, readStdin, runHook } from "./hook.js";
import { buildServer } from "./server.js";

function log(msg: string): void {
  process.stderr.write(`[learned-experience] ${msg}\n`);
}

type Command = "export" | "import" | "hook" | "recall" | "stats" | "install" | "uninstall";

const USAGE =
  "usage: learned-experience [--http [--port N] [--host H]]\n" +
  "       learned-experience install [host ...] [--dry-run] [--local]   register server + hooks with detected agent hosts\n" +
  "       learned-experience uninstall [host ...] [--dry-run]\n" +
  "       learned-experience hook [--codex] | recall <text> | stats | export <file> | import <file>\n" +
  `hosts: ${ALL_HOSTS.join(", ")}\n`;

function parseArgs(argv: string[]) {
  const args = {
    http: false,
    port: 3111,
    host: "127.0.0.1",
    command: null as null | Command,
    file: "",
    text: "",
    hosts: [] as HostId[],
    dryRun: false,
    local: false,
    codex: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--host") args.host = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--local") args.local = true;
    else if (a === "--codex") args.codex = true;
    else if (a === "hook" || a === "stats" || a === "install" || a === "uninstall") args.command = a;
    else if (a === "recall") {
      args.command = a;
      args.text = argv.slice(i + 1).join(" ");
      break;
    } else if (a === "export" || a === "import") {
      args.command = a;
      args.file = argv[++i] ?? "";
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if ((ALL_HOSTS as string[]).includes(a)) args.hosts.push(a as HostId);
    else throw new Error(`unknown argument '${a}'\n${USAGE}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = configFromEnv();

  if (args.command === "install" || args.command === "uninstall") {
    const uninstall = args.command === "uninstall";
    const launch = args.local ? { command: process.execPath, args: [fileURLToPath(new URL("./index.js", import.meta.url))] } : undefined;
    const reports = installHosts({ home: homedir(), hosts: args.hosts.length ? args.hosts : undefined, dryRun: args.dryRun, uninstall, launch });
    process.stdout.write(formatReport(reports, args.dryRun, uninstall));
    return;
  }

  if (args.command === "hook") {
    // Never break the user's session: any failure here is logged and swallowed.
    try {
      const payload = JSON.parse(await readStdin()) as Parameters<typeof runHook>[0];
      const hookOptions = { ...hookOptionsFromEnv(process.env), codex: args.codex };
      // Disabled Stop hooks need neither the catalogue nor a model/database startup.
      if (payload.hook_event_name === "Stop" && !hookOptions.stopNudge) return;
      const { store, catalogue } = await openCatalogue(cfg);
      const out = await runHook(payload, catalogue, { ...hookOptions, claimReminder: (key) => store.claimHookReminder(key) });
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
