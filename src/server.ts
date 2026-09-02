/**
 * MCP surface. Eight tools, one resource, one prompt. Tool descriptions are written for
 * the model that will call them: when to call, what to pass, what comes back.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { Catalogue } from "./catalogue.js";
import { ExperienceInput, Kind, Outcome, Attempt, Source } from "./schema.js";

export const SERVER_NAME = "learned-experience";
export const SERVER_VERSION = "0.1.0";

export const PROTOCOL = `learned-experience: a persistent catalogue of problems this user's agents have solved before. It is shared across every model and tool the user works with. Use it so nothing has to be learned twice.

THE LOOP
1. TRIGGER -> recall. Before investigating an error, a failing command, a confusing behaviour, or any task you suspect has come up before, call \`recall\`. Put exact error text in \`signals\` (that is what makes matching deterministic) and a short generic statement in \`problem\`.
2. APPLY -> reinforce. If a hit fits, try its \`fix\` first and respect its \`avoid\` list. Then call \`reinforce\` with worked=true or false. This feedback is what makes the catalogue improve over time. Skip this step and nothing learns.
3. SOLVE -> record. After solving something non-trivial (more than one attempt, or not obvious next time), call \`record\` once. Generalise the problem statement, keep signals exact, state the fix concretely enough to repeat, and list what did not work in \`avoid\`. Record failures too: knowing a dead end is worth something.

RULES
- Be terse. Records are read by models on every future recall; every word costs.
- Never include secrets, credentials, or personal data. Redaction runs server-side but do not rely on it.
- Do not record trivial or one-off facts. Do not worry about duplicates: \`record\` merges them.
- Trust confidence. >= 0.7 means the fix has repeatedly worked; <= 0.3 means it has repeatedly failed.
- When \`consolidate\` returns a cluster, write one \`rule\` record that generalises it.`;

/**
 * The transfer tool may only touch `.jsonl` files inside one directory. An agent steered by
 * injected content must not be able to turn export/import into arbitrary file write/read.
 */
export function resolveTransferPath(requested: string, transferDir: string): string {
  const root = resolve(transferDir);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path must stay inside the transfer directory ${root}`);
  if (extname(target) !== ".jsonl") throw new Error("path must end in .jsonl");
  return target;
}

export interface ServerOptions {
  /** Directory the transfer tool is confined to. */
  transferDir: string;
}

export function buildServer(catalogue: Catalogue, options: ServerOptions): McpServer {
  const { transferDir } = options;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: PROTOCOL });

  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const fail = (e: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
  });

  server.registerTool(
    "recall",
    {
      title: "Recall past experience",
      description:
        "Check whether this problem (or a similar one) has been solved before. Call BEFORE investigating. " +
        "Returns ranked hits with fix, avoid-list and confidence. Exact error text in `signals` enables deterministic matching; " +
        "semantic + lexical search catches near matches. Read-only.",
      inputSchema: {
        problem: z.string().min(3).max(240).describe("One-line generic description of the problem"),
        signals: z.array(z.string().max(300)).max(8).optional().describe("Exact error messages, failing commands, symptoms"),
        context: z.array(z.string().max(40)).max(10).optional().describe("Tags: language, framework, tool, OS"),
        limit: z.number().int().min(1).max(25).optional().describe("Max hits (default 5)"),
        min_score: z.number().min(0).max(1).optional().describe("Drop non-exact hits below this score (default 0.35)"),
        kinds: z.array(Kind).optional().describe("Restrict to 'episode' or 'rule' records"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return json(await catalogue.recall(args));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "record",
    {
      title: "Record an experience",
      description:
        "Store what happened after solving (or failing to solve) a non-trivial problem. Duplicates are merged automatically: " +
        "the response says whether the record was created, merged into an existing one, or linked to one with a different fix. " +
        "Keep it terse and never include secrets.",
      inputSchema: {
        problem: ExperienceInput.shape.problem,
        signals: z.array(z.string().min(1).max(300)).max(8).optional().describe(ExperienceInput.shape.signals.description ?? ""),
        context: z.array(z.string().min(1).max(40)).max(10).optional().describe(ExperienceInput.shape.context.description ?? ""),
        attempts: z.array(Attempt).max(12).optional().describe("Ordered attempts and whether each worked"),
        fix: z.string().max(600).optional().describe("What finally worked, concrete enough to repeat. Omit if unresolved."),
        avoid: z.array(z.string().min(1).max(200)).max(8).optional().describe("What did not work or made things worse"),
        root_cause: z.string().max(300).optional().describe("Why it happened, if known"),
        outcome: Outcome,
        kind: Kind.optional().describe("'episode' (default) or 'rule' for a generalisation of several episodes"),
        source: Source.optional().describe("Provenance: which agent/model is recording"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return json(await catalogue.record(ExperienceInput.parse(args)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reinforce",
    {
      title: "Report whether a recalled fix worked",
      description:
        "Feedback loop. After applying a fix from `recall`, report whether it worked. Updates the record's confidence, " +
        "which drives future ranking. If it failed, pass a short note and it is added to the record's avoid-list.",
      inputSchema: {
        id: z.string().describe("Experience id from recall"),
        worked: z.boolean(),
        note: z.string().max(200).optional().describe("If it failed: what went wrong, one line"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, worked, note }) => {
      try {
        const e = await catalogue.reinforce(id, worked, note);
        return json({ id: e.id, stats: e.stats, confidence: Math.round(((e.stats.successes + 1) / (e.stats.uses + 2)) * 1000) / 1000 });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "amend",
    {
      title: "Amend an experience",
      description: "Patch fields of an existing record (better fix, extra avoid items, corrected context). Only supplied fields change.",
      inputSchema: {
        id: z.string(),
        patch: z
          .object({
            problem: z.string().min(3).max(240).optional(),
            signals: z.array(z.string().min(1).max(300)).max(8).optional(),
            context: z.array(z.string().min(1).max(40)).max(10).optional(),
            attempts: z.array(Attempt).max(12).optional(),
            fix: z.string().max(600).optional(),
            avoid: z.array(z.string().min(1).max(200)).max(8).optional(),
            root_cause: z.string().max(300).optional(),
            outcome: Outcome.optional(),
            kind: Kind.optional(),
          })
          .describe("Fields to replace"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, patch }) => {
      try {
        return json(await catalogue.amend(id, patch));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "forget",
    {
      title: "Delete an experience",
      description: "Permanently remove a record that is wrong or obsolete.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        return json({ id, deleted: await catalogue.forget(id) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "consolidate",
    {
      title: "Find clusters of similar experiences",
      description:
        "Deterministic clustering of episodes that look like the same underlying lesson. For each cluster, write ONE `record` " +
        "with kind='rule' that generalises them. Read-only; nothing is changed by this call.",
      inputSchema: {
        threshold: z.number().min(0.5).max(1).optional().describe("Cosine similarity to cluster at (default 0.8)"),
        min_size: z.number().int().min(2).max(50).optional().describe("Minimum cluster size to report (default 3)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ threshold, min_size }) => {
      try {
        return json({ clusters: await catalogue.consolidate(threshold, min_size) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "stats",
    {
      title: "Catalogue statistics",
      description: "Counts, success rate, duplicates prevented, embedding status, most common context tags.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return json(await catalogue.stats());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "transfer",
    {
      title: "Export or import the catalogue",
      description:
        "Portability. mode='export' writes every record as JSONL (to `path` if given, else returned inline). " +
        "mode='import' reads JSONL from `path` or `jsonl` and merges it idempotently: newer wins on id clash, duplicates are merged. " +
        "Paths are `.jsonl` files inside the transfer directory (relative names are resolved there). " +
        "Embeddings are not transferred; they are recomputed by whichever model the destination uses.",
      inputSchema: {
        mode: z.enum(["export", "import"]),
        path: z.string().optional().describe("File name or path (.jsonl) inside the transfer directory"),
        jsonl: z.string().optional().describe("Inline JSONL for import"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ mode, path, jsonl }) => {
      try {
        if (mode === "export") {
          const text = await catalogue.exportJsonl();
          if (path) {
            const target = resolveTransferPath(path, transferDir);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, text + "\n", "utf8");
            return json({ path: target, records: text ? text.split("\n").length : 0 });
          }
          return { content: [{ type: "text" as const, text }] };
        }
        const input = jsonl ?? (path ? await readFile(resolveTransferPath(path, transferDir), "utf8") : null);
        if (input === null) throw new Error("import needs `path` or `jsonl`");
        return json(await catalogue.importJsonl(input));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerResource(
    "protocol",
    "learned-experience://protocol",
    { title: "How to use the experience catalogue", mimeType: "text/plain", description: "The recall -> apply -> reinforce -> record loop" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: PROTOCOL }] })
  );

  server.registerPrompt(
    "solve",
    {
      title: "Solve a problem using past experience",
      description: "Wraps a problem in the recall -> apply -> reinforce -> record loop.",
      argsSchema: { problem: z.string().describe("The problem to solve"), error: z.string().optional().describe("Exact error text, if any") },
    },
    ({ problem, error }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Solve this problem using the experience catalogue.\n\nProblem: ${problem}\n${error ? `Error: ${error}\n` : ""}\n` +
              `Steps: (1) call recall with the problem and the exact error in signals; (2) if a hit fits, apply its fix and call reinforce with the result; ` +
              `(3) if you had to work it out yourself, call record once with what worked and what did not.`,
          },
        },
      ],
    })
  );

  return server;
}
