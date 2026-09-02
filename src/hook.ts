/**
 * Claude Code hooks. One command, `learned-experience hook`, dispatches on the event name:
 *
 *   PostToolUseFailure  a tool call failed -> recall by error text, inject matching fixes
 *   UserPromptSubmit    the user asked for something -> recall by the request, inject relevant past experience
 *   Stop                the turn is ending -> if it had failures and nothing was recorded, ask once for a record
 *
 * Everything before the catalogue lookup is deterministic string processing. The hook never blocks
 * a session on error: any failure is logged to stderr and the hook stays silent.
 */
import { readFile } from "node:fs/promises";
import type { Catalogue } from "./catalogue.js";
import { clean } from "./normalize.js";
import type { RecallHit } from "./schema.js";

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: unknown;
  prompt?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  session_id?: string;
}

export interface HookQuery {
  problem: string;
  signals: string[];
  context: string[];
}

export interface HookOptions {
  limit?: number;
  /** Failure hook: say nothing when no record matches (default: a one-line nudge to record). */
  quietOnMiss?: boolean;
  /** Stop hook: disable the end-of-turn record reminder. */
  stopNudge?: boolean;
  /** Stop hook thresholds. */
  stopMinFailures?: number;
  stopMinToolCalls?: number;
  stopLongTurn?: number;
  /** Test seam for reading the transcript. */
  readTranscript?: (path: string) => Promise<string>;
}

const NAME = "learned-experience";
const ERROR_LINE = /\b(error|exception|fail(ed|ure|s|ing)?|denied|not found|cannot|can't|unable|refused|panic|traceback|fatal|invalid|missing|timed? ?out|unexpected|broken|crash(es|ed|ing)?|ENOENT|EACCES|ECONN)\b/i;
const NOISE_LINE = /^\s*(at\s+\S|\s*\^+\s*$|node:internal|\(node:\d+\)|npm (ERR!|warn)\s*$|\s*$)/i;
const SKIP_ERROR = /\b(interrupted|cancel+ed|aborted by user|user denied|permission (was )?denied by (the )?user|rejected by user)\b/i;
const OWN_TOOL = /learned-experience__/;

// ------------------------------------------------------------------ shared

/** Pull text out of whatever shape a tool response takes. */
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

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
}

function hitLine(h: RecallHit, i: number): string {
  const parts = [`${i + 1}. [${h.id}] ${h.problem}`];
  if (h.fix) parts.push(`fix: ${h.fix}`);
  if (h.avoid.length) parts.push(`avoid: ${h.avoid.join("; ")}`);
  if (h.root_cause) parts.push(`cause: ${h.root_cause}`);
  parts.push(`(confidence ${h.confidence}${h.match.exact ? ", exact match" : `, score ${h.match.score}`}${h.outcome === "failure" ? ", unresolved last time" : ""})`);
  return parts.join(" | ");
}

// --------------------------------------------------------- tool failure hook

/** Turn a failure payload into a recall query. Returns null when the failure is not worth a lookup. */
export function queryFromFailure(input: HookInput): HookQuery | null {
  const tool = input.tool_name ?? "";
  if (!tool || OWN_TOOL.test(tool)) return null; // never react to our own tools
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

/** The text injected after a failure. */
export function formatContext(hits: RecallHit[], searched: number, quietOnMiss: boolean): string | null {
  if (hits.length === 0) {
    if (quietOnMiss) return null;
    return (
      `${NAME}: no past experience matches this failure (searched ${searched} records). ` +
      `If solving it takes more than one attempt, call ${NAME} \`record\` once when done.`
    );
  }
  return (
    `${NAME}: ${hits.length} past experience${hits.length === 1 ? " matches" : "s match"} this failure.\n` +
    hits.map(hitLine).join("\n") +
    `\nApply the best-fitting fix first, then call ${NAME} \`reinforce\` with its id and whether it worked. ` +
    `If none fit and you solve it another way, call \`record\` once.`
  );
}

async function failureHook(input: HookInput, catalogue: Catalogue, opts: HookOptions): Promise<Record<string, unknown> | null> {
  const query = queryFromFailure(input);
  if (!query) return null;
  const res = await catalogue.recall({ ...query, limit: opts.limit ?? 3 });
  const text = formatContext(res.hits, res.searched, opts.quietOnMiss ?? false);
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: text } };
}

// ---------------------------------------------------------- user prompt hook

/** Turn the user's request into a recall query. Short prompts and slash commands are skipped. */
export function queryFromPrompt(prompt: string): HookQuery | null {
  const p = prompt.trim();
  if (p.length < 20 || p.startsWith("/")) return null;
  const lines = p
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 8 && !NOISE_LINE.test(l));
  const signals = uniq(lines.filter((l) => ERROR_LINE.test(l)))
    .slice(0, 4)
    .map((l) => clean(l, 300));
  return { problem: clean(p, 240), signals, context: [] };
}

/** The text injected before the model starts on a request. Silent on a miss: most prompts have no history. */
export function formatPromptContext(hits: RecallHit[]): string | null {
  if (hits.length === 0) return null;
  return (
    `${NAME}: ${hits.length} past experience${hits.length === 1 ? " looks" : "s look"} relevant to this request.\n` +
    hits.map(hitLine).join("\n") +
    `\nIf one applies, use it and call ${NAME} \`reinforce\` with the result. If none apply, ignore this.`
  );
}

async function promptHook(input: HookInput, catalogue: Catalogue, opts: HookOptions): Promise<Record<string, unknown> | null> {
  const query = queryFromPrompt(input.prompt ?? "");
  if (!query) return null;
  // Higher bar than the failure hook: a request is a weaker signal than an error string.
  const res = await catalogue.recall({ ...query, limit: opts.limit ?? 3, min_score: 0.5 });
  const text = formatPromptContext(res.hits);
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
}

// ------------------------------------------------------------------ stop hook

export interface TurnSummary {
  toolCalls: number;
  failures: number;
  recorded: boolean;
  recalled: boolean;
}

/**
 * Summarise the last turn of a Claude Code transcript (JSONL): how many tool calls, how many failed,
 * and whether the model already talked to the catalogue. Unknown line shapes are ignored.
 */
export function summarizeLastTurn(jsonl: string): TurnSummary {
  const entries: Array<{ type?: string; message?: { role?: string; content?: unknown } }> = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip malformed lines */
    }
  }
  const blocks = (e: (typeof entries)[number]): Array<Record<string, unknown>> => {
    const c = e.message?.content;
    if (typeof c === "string") return [{ type: "text", text: c }];
    return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : [];
  };
  // The turn starts at the last human message: a user entry with text and no tool results.
  let start = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "user" && e.message?.role !== "user") continue;
    const b = blocks(e);
    if (b.length > 0 && b.every((x) => x.type === "text")) start = i;
  }
  const summary: TurnSummary = { toolCalls: 0, failures: 0, recorded: false, recalled: false };
  for (const e of entries.slice(start)) {
    for (const b of blocks(e)) {
      if (b.type === "tool_use") {
        summary.toolCalls++;
        const name = String(b.name ?? "");
        if (OWN_TOOL.test(name) && /(record|reinforce)$/.test(name)) summary.recorded = true;
        if (OWN_TOOL.test(name) && /recall$/.test(name)) summary.recalled = true;
      } else if (b.type === "tool_result" && b.is_error === true) {
        summary.failures++;
      }
    }
  }
  return summary;
}

export function stopDecision(summary: TurnSummary, opts: HookOptions): Record<string, unknown> | null {
  if (summary.recorded) return null;
  const minFailures = opts.stopMinFailures ?? 1;
  const minCalls = opts.stopMinToolCalls ?? 3;
  const longTurn = opts.stopLongTurn ?? 15;
  const eventful = (summary.failures >= minFailures && summary.toolCalls >= minCalls) || summary.toolCalls >= longTurn;
  if (!eventful) return null;
  const why =
    summary.failures > 0
      ? `${summary.failures} failed tool call${summary.failures === 1 ? "" : "s"} across ${summary.toolCalls} calls`
      : `${summary.toolCalls} tool calls`;
  return {
    decision: "block",
    reason:
      `${NAME}: this turn had ${why} and nothing was recorded. ` +
      `If a non-trivial problem was solved, call ${NAME} \`record\` once` +
      (summary.recalled ? ", or `reinforce` if a recalled fix was applied" : "") +
      `. If nothing worth keeping happened, stop as planned.`,
  };
}

async function stopHook(input: HookInput, opts: HookOptions): Promise<Record<string, unknown> | null> {
  if (opts.stopNudge === false) return null;
  if (input.stop_hook_active) return null; // we already asked once this turn; never loop
  if (!input.transcript_path) return null;
  const read = opts.readTranscript ?? ((p: string) => readFile(p, "utf8"));
  const summary = summarizeLastTurn(await read(input.transcript_path));
  return stopDecision(summary, opts);
}

// ------------------------------------------------------------------ dispatch

/** Payload in, Claude Code hook JSON out (or null for silence). */
export async function runHook(input: HookInput, catalogue: Catalogue, opts: HookOptions = {}): Promise<Record<string, unknown> | null> {
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return promptHook(input, catalogue, opts);
    case "Stop":
      return stopHook(input, opts);
    case "PostToolUseFailure":
    case undefined: // older registrations passed no event name; treat as a failure payload
      return failureHook(input, catalogue, opts);
    default:
      return null;
  }
}

export function hookOptionsFromEnv(env: NodeJS.ProcessEnv): HookOptions {
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  return {
    quietOnMiss: env.LEARNED_EXPERIENCE_HOOK_QUIET === "1",
    stopNudge: env.LEARNED_EXPERIENCE_STOP_NUDGE !== "0",
    stopMinFailures: num(env.LEARNED_EXPERIENCE_STOP_MIN_FAILURES),
    stopMinToolCalls: num(env.LEARNED_EXPERIENCE_STOP_MIN_CALLS),
    stopLongTurn: num(env.LEARNED_EXPERIENCE_STOP_LONG_TURN),
  };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
