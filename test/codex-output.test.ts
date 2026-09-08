import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { runHook, type HookInput } from "../src/hook.js";
import { Store } from "../src/store.js";

const ajv = new Ajv();
const validate = Object.fromEntries(["PostToolUse", "UserPromptSubmit"].map((event, i) => [
  event, ajv.compile(JSON.parse(readFileSync(new URL(
    `./fixtures/codex/${i ? "user-prompt-submit" : "post-tool-use"}.command.output.schema.json`, import.meta.url), "utf8"))),
]));

it.each(["flag", "turn_id"])("validates emitted Codex context via %s and preserves legacy output", async (mode) => {
  const store = new Store(":memory:");
  const cat = new Catalogue(store, null);
  const prompt = "Error: Cannot find module vitest when running npm test";
  try {
    await cat.record({ problem: prompt, signals: [prompt], context: [], fix: "Install project dependencies", avoid: [], outcome: "success", kind: "episode", attempts: [] });
    const row = (payload: unknown) => JSON.stringify({ type: "response_item", payload });
    const transcript = [
      row({ type: "message", role: "user", content: [{ type: "input_text", text: "Fix tests" }] }),
      ...Array.from({ length: 3 }, (_, i) => [
        row({ type: "function_call", name: "shell", arguments: "{}" }),
        row({ type: "function_call_output", output: JSON.stringify({ exit_code: i === 0 ? 1 : 0 }) }),
      ]).flat(),
    ].join("\n");
    const payloads: HookInput[] = [
      { hook_event_name: "PostToolUse", tool_name: "shell", tool_response: { exit_code: 1, output: prompt } },
      { hook_event_name: "PostToolUse", tool_name: "shell", tool_response: { exit_code: 1, output: "Error: unrelated unique database failure" } },
      { hook_event_name: "UserPromptSubmit", prompt },
      { hook_event_name: "PostToolUse", tool_name: "shell", tool_response: { exit_code: 0 }, transcript_path: "/test" },
    ];
    for (const payload of payloads) {
      const opts = { readTranscript: async () => transcript, claimReminder: () => true };
      const legacy = await runHook(payload, cat, opts);
      expect(legacy?.additionalContext).toEqual(expect.any(String));
      const codex = await runHook({ ...payload, ...(mode === "turn_id" ? { turn_id: "turn-1" } : {}) }, cat, { ...opts, codex: mode === "flag" });
      expect(codex).not.toBeNull();
      expect(codex).not.toHaveProperty("additionalContext");
      expect(codex?.hookSpecificOutput).toEqual(legacy?.hookSpecificOutput);
      expect(validate[payload.hook_event_name!](codex)).toBe(true);
      // Prove the fixture catches the original defect, including non-silent runs.
      expect(validate[payload.hook_event_name!](legacy)).toBe(false);
    }
    expect(await runHook({ hook_event_name: "Stop" }, cat, { codex: true })).toBeNull();
    expect(await runHook({ hook_event_name: "PostToolUse", tool_name: "shell", tool_response: { exit_code: 0 } }, cat, { codex: true })).toBeNull();
  } finally { store.close(); }
});
