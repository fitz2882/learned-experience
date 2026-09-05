import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { hookOptionsFromEnv, runHook } from "../src/hook.js";
import { Store } from "../src/store.js";

const line = (payload: unknown) => JSON.stringify({ type: "response_item", payload });
const user = (text: string) => line({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const call = (name: string, failed = false) => [
  line({ type: "function_call", name, arguments: "{}" }),
  line({ type: "function_call_output", output: JSON.stringify({ exit_code: failed ? 1 : 0 }) }),
].join("\n");
const task = (calls = 3, failures = 1) => [user("Fix the build"), ...Array.from({ length: calls }, (_, i) => call("shell", i < failures))].join("\n");
const input = { hook_event_name: "PostToolUse", tool_name: "shell", tool_response: { exit_code: 0 }, transcript_path: "/session.jsonl" };

function setup() {
  const store = new Store(":memory:");
  const cat = new Catalogue(store, null);
  const opts = (text: string) => ({ readTranscript: async () => text, claimReminder: (key: string) => store.claimHookReminder(key) });
  return { store, cat, opts };
}

describe("non-blocking record reminder", () => {
  it("reminds after eventful work once, then lets the final answer complete", async () => {
    const { store, cat, opts } = setup();
    try {
      const out = await runHook(input, cat, opts(task()));
      expect(out?.decision).toBeUndefined();
      expect(out?.reason).toBeUndefined();
      expect(out?.additionalContext).toContain("before your final answer");
      expect(out?.additionalContext).toContain("outcome is verified");
      expect(out?.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUse", additionalContext: out?.additionalContext });
      expect(await runHook(input, cat, opts(task()))).toBeNull();
      expect(await runHook(input, cat, opts(task() + "\n" + call("shell")))).toBeNull();
      expect(await runHook({ hook_event_name: "Stop", transcript_path: "/session.jsonl" }, cat, opts(task()))).toBeNull();
    } finally { store.close(); }
  });

  it("allows a new turn, repeated user wording, or a different session to get a reminder", async () => {
    const { store, cat, opts } = setup();
    try {
      expect(await runHook(input, cat, opts(task()))).not.toBeNull();
      expect(await runHook(input, cat, opts(task() + "\n" + task()))).not.toBeNull();
      expect(await runHook({ ...input, transcript_path: "/other.jsonl" }, cat, opts(task()))).not.toBeNull();
    } finally { store.close(); }
  });

  it("handles long successful work and configurable thresholds", async () => {
    const { store, cat, opts } = setup();
    try {
      expect(await runHook(input, cat, opts(task(14, 0)))).toBeNull();
      expect(await runHook(input, cat, opts(task(15, 0)))).not.toBeNull();
      const custom = hookOptionsFromEnv({ LEARNED_EXPERIENCE_RECORD_MIN_FAILURES: "2", LEARNED_EXPERIENCE_RECORD_MIN_CALLS: "5", LEARNED_EXPERIENCE_RECORD_LONG_TURN: "20" });
      const other = { ...input, transcript_path: "/custom.jsonl" };
      expect(await runHook(other, cat, { ...opts(task(4, 2)), ...custom })).toBeNull();
      expect(await runHook(other, cat, { ...opts(task(5, 2)), ...custom })).not.toBeNull();
    } finally { store.close(); }
  });

  it.each(["mcp__learned-experience__record", "mcp__learned_experience__record", "mcp__learned_experience__reinforce"])("stays silent after %s", async (name) => {
    const { store, cat, opts } = setup();
    try {
      expect(await runHook(input, cat, opts(task() + "\n" + call(name)))).toBeNull();
      expect(await runHook({ ...input, tool_name: name }, cat, opts(task()))).toBeNull();
    } finally { store.close(); }
  });

  it("does not claim a reminder for missing/unknown transcripts, opt-out, or a completed final", async () => {
    const { store, cat, opts } = setup();
    try {
      expect(await runHook(input, cat, opts("not json"))).toBeNull();
      expect(await runHook(input, cat, { ...opts(task()), readTranscript: async () => { throw new Error("ENOENT"); } })).toBeNull();
      expect(await runHook({ ...input, transcript_path: undefined }, cat, opts(task()))).toBeNull();
      expect(await runHook(input, cat, { ...opts(task()), ...hookOptionsFromEnv({ LEARNED_EXPERIENCE_RECORD_NUDGE: "0" }) })).toBeNull();
      const final = line({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "The user's answer" }] });
      expect(await runHook(input, cat, opts(task() + "\n" + final))).toBeNull();
      expect(await runHook(input, cat, opts(task()))).not.toBeNull();
    } finally { store.close(); }
  });

  it("preserves failure recall without consuming the successful-call reminder", async () => {
    const { store, cat, opts } = setup();
    try {
      const failed = await runHook({ ...input, tool_response: { exit_code: 1, output: "Error: Cannot find module vitest" } }, cat, opts(task()));
      expect(failed?.additionalContext).toContain("no past experience");
      expect(failed?.decision).toBeUndefined();
      expect(await runHook(input, cat, opts(task()))).not.toBeNull();
    } finally { store.close(); }
  });

  it("also handles Claude successful PostToolUse events", async () => {
    const { store, cat, opts } = setup();
    try {
      const text = [
        JSON.stringify({ type: "user", message: { role: "user", content: "Fix build" } }),
        ...Array.from({ length: 3 }, (_, i) => [
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
          JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: i === 0 }] } }),
        ]).flat(),
      ].join("\n");
      expect((await runHook({ ...input, tool_name: "Bash" }, cat, opts(text)))?.additionalContext).toContain("before your final answer");
    } finally { store.close(); }
  });

  it("deduplicates across independent hook database connections without storing transcript text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-reminder-"));
    const db = join(dir, "experiences.db");
    const first = new Store(db);
    const second = new Store(db);
    const keys: string[] = [];
    try {
      const options = (store: Store) => ({ readTranscript: async () => task(), claimReminder: (key: string) => { keys.push(key); return store.claimHookReminder(key); } });
      expect(await runHook(input, new Catalogue(first, null), options(first))).not.toBeNull();
      expect(await runHook(input, new Catalogue(second, null), options(second))).toBeNull();
      expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(keys[1]).toBe(keys[0]);
      expect(first.count()).toBe(0);
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
