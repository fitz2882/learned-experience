/**
 * Claude Code hook: fires on PostToolUseFailure, turns the failure into a recall query,
 * and injects matching past experience straight into the model's context. The model does not
 * have to remember to call `recall`; the trigger is mechanical.
 *
 * Input (stdin): the hook payload Claude Code sends, e.g.
 *   { hook_event_name: "PostToolUseFailure", tool_name: "Bash",
 *     tool_input: { command: "npm test" }, error: "Command exited with code 1", tool_response: "..." }
 * Output (stdout): { hookSpecificOutput: { hookEventName, additionalContext } } or nothing.
 */
import type { Catalogue } from "./catalogue.js";
import { clean } from "./normalize.js";
import type { RecallHit } from "./schema.js";

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: unknown;
  session_id?: string;
}

export interface HookQuery {
  problem: string;
  signals: string[];
  context: string[];
}

const ERROR_LINE = /\b(error|exception|fail(ed|ure)?|denied|not found|cannot|can't|unable|refused|panic|traceback|fatal|invalid|missing|timed? ?out|unexpected|ENOENT|EACCES|ECONN)\b/i;
const NOISE_LINE = /^\s*(at\s+\S|\s*\^+\s*$|node:internal|\(node:\d+\)|npm (ERR!|warn)\s*$|\s*$)/i;
const SKIP_ERROR = /\b(interrupted|cancel+ed|aborted by user|user denied|permission (was )?denied by (the )?user|rejected by user)\b/i;

/** Pull text out of whatever shape the tool response takes. */
export function responseText(value: unknown, depth = 0): string {
  if (value == null || depth > 3) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => responseText(v, depth + 1)).join("\n");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = ["error", "stderr", "stdout", "message", "text", "content", "output", "result"];
    return keys
      .filter((k) => k in o)
      .map((k) => responseText(o[k], depth + 1))
      .join("\n");
  }
  return String(value);
}

/** Turn a failure payload into a recall query. Returns null when the failure is not worth a lookup. */
export function queryFromFailure(input: HookInput): HookQuery | null {
  const tool = input.tool_name ?? "";
  if (!tool || /^mcp__learned-experience__/.test(tool)) return null; // never react to our own tools
  const error = typeof input.error === "string" ? input.error : responseText(input.error);
  if (SKIP_ERROR.test(error)) return null;

  const raw = [error, responseText(input.tool_response)].join("\n");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 8 && !NOISE_LINE.test(l));
  const errorLines = lines.filter((l) => ERROR_LINE.test(l));
  const picked = uniq([...errorLines, ...lines]).slice(0, 4);
  if (picked.length === 0) return null;

  const signals = picked.map((l) => clean(l, 300));
  const context = [tool.toLowerCase()];
  const command = (input.tool_input as { command?: unknown } | undefined)?.command;
  if (typeof command === "string") {
    const first = command.trim().split(/\s+/)[0]?.replace(/^.*\//, "");
    if (first && /^[a-z0-9._+-]{2,30}$/i.test(first)) context.push(first.toLowerCase());
  }
  const problem = clean(`${tool} failed: ${signals[0]}`, 240);
  return { problem, signals, context };
}

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
}

/** The text injected into the model's context. */
export function formatContext(hits: RecallHit[], searched: number, quietOnMiss: boolean): string | null {
  if (hits.length === 0) {
    if (quietOnMiss) return null;
    return (
      `learned-experience: no past experience matches this failure (searched ${searched} records). ` +
      `If solving it takes more than one attempt, call learned-experience \`record\` once when done.`
    );
  }
  const lines = hits.map((h, i) => {
    const parts = [`${i + 1}. [${h.id}] ${h.problem}`];
    if (h.fix) parts.push(`fix: ${h.fix}`);
    if (h.avoid.length) parts.push(`avoid: ${h.avoid.join("; ")}`);
    if (h.root_cause) parts.push(`cause: ${h.root_cause}`);
    parts.push(`(confidence ${h.confidence}${h.match.exact ? ", exact match" : `, score ${h.match.score}`}${h.outcome === "failure" ? ", unresolved last time" : ""})`);
    return parts.join(" | ");
  });
  return (
    `learned-experience: ${hits.length} past experience${hits.length === 1 ? " matches" : "s match"} this failure.\n` +
    lines.join("\n") +
    `\nApply the best-fitting fix first, then call learned-experience \`reinforce\` with its id and whether it worked. ` +
    `If none fit and you solve it another way, call \`record\` once.`
  );
}

export interface HookOptions {
  limit?: number;
  quietOnMiss?: boolean;
}

/** Full hook: payload in, Claude Code hook JSON out (or null for silence). */
export async function runHook(input: HookInput, catalogue: Catalogue, opts: HookOptions = {}): Promise<Record<string, unknown> | null> {
  const query = queryFromFailure(input);
  if (!query) return null;
  const res = await catalogue.recall({ ...query, limit: opts.limit ?? 3 });
  const text = formatContext(res.hits, res.searched, opts.quietOnMiss ?? false);
  if (!text) return null;
  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name ?? "PostToolUseFailure",
      additionalContext: text,
    },
  };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
