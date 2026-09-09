import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { formatContext, hookOptionsFromEnv, looksFailed, queryFromFailure, queryFromPrompt, responseText, runHook, stopDecision, summarizeLastTurn } from "../src/hook.js";
import { Store } from "../src/store.js";
import { FakeEmbedder } from "./fake-embedder.js";

const bashFailure = {
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command: "npm install -g typescript", description: "Install tsc" },
  tool_use_id: "toolu_1",
  error: "Command exited with code 243",
  tool_response:
    "npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /usr/local/lib/node_modules/typescript\n" +
    "npm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/typescript'\n    at Object.mkdirSync (node:fs:1234)\n",
};

describe("queryFromFailure", () => {
  it("builds a recall query from a Bash failure payload", () => {
    const q = queryFromFailure(bashFailure)!;
    expect(q.context).toEqual(["bash", "npm"]);
    expect(q.signals[0]).toMatch(/EACCES/);
    expect(q.signals.some((s) => s.includes("permission denied, mkdir"))).toBe(true);
    expect(q.signals.every((s) => !s.startsWith("at Object"))).toBe(true);
    expect(q.problem).toMatch(/^Bash failed: /);
    expect(q.problem.length).toBeLessThanOrEqual(240);
  });

  it("handles object-shaped tool responses and MCP tool names", () => {
    const q = queryFromFailure({
      tool_name: "mcp__github__create_issue",
      error: { message: "HTTP 422: Validation Failed" },
      tool_response: { content: [{ type: "text", text: "Resource not accessible by integration" }] },
    })!;
    expect(q.context).toEqual(["mcp__github__create_issue"]);
    expect(q.signals).toEqual(["HTTP 422: Validation Failed", "Resource not accessible by integration"]);
  });

  it("ignores its own tools and user interruptions", () => {
    expect(queryFromFailure({ tool_name: "mcp__learned-experience__recall", error: "boom failed" })).toBeNull();
    expect(queryFromFailure({ tool_name: "Bash", error: "Command was interrupted by the user" })).toBeNull();
    expect(queryFromFailure({ tool_name: "Bash", error: "Permission denied by user" })).toBeNull();
    expect(queryFromFailure({ tool_name: "Bash", error: "" })).toBeNull();
    expect(queryFromFailure({})).toBeNull();
  });

  it("responseText flattens strings, arrays and objects", () => {
    expect(responseText("x")).toBe("x");
    expect(responseText(["a", { stderr: "b" }])).toBe("a\nb");
    expect(responseText({ stdout: "out", stderr: "err" })).toBe("err\nout");
  });
});

describe("runHook", () => {
  it("injects matching experience as additionalContext", async () => {
    const cat = new Catalogue(new Store(":memory:"), new FakeEmbedder());
    const r = await cat.record({
      problem: "Global npm install fails with EACCES on the default prefix",
      signals: ["Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/typescript'"],
      context: ["npm", "macos"],
      fix: "npm config set prefix ~/.npm-global and add ~/.npm-global/bin to PATH",
      avoid: ["sudo npm install -g"],
      outcome: "success",
      kind: "episode",
      attempts: [],
    });
    const out = (await runHook(bashFailure, cat))!;
    const ctx = (out.hookSpecificOutput as { hookEventName: string; additionalContext: string });
    expect(ctx.hookEventName).toBe("PostToolUseFailure");
    expect(ctx.additionalContext).toContain(`[${r.id}]`);
    expect(ctx.additionalContext).toContain("fix: npm config set prefix");
    expect(ctx.additionalContext).toContain("avoid: sudo npm install -g");
    expect(ctx.additionalContext).toContain("exact match");
    expect(ctx.additionalContext).toContain("reinforce");
  });

  it("nudges to record when nothing matches, unless quiet", async () => {
    const cat = new Catalogue(new Store(":memory:"), null);
    const out = (await runHook(bashFailure, cat))!;
    expect((out.hookSpecificOutput as { additionalContext: string }).additionalContext).toMatch(/no past experience/);
    expect(await runHook(bashFailure, cat, { quietOnMiss: true })).toBeNull();
  });

  it("stays silent for payloads that are not worth a lookup", async () => {
    const cat = new Catalogue(new Store(":memory:"), null);
    expect(await runHook({ tool_name: "mcp__learned-experience__record", error: "x failed" }, cat)).toBeNull();
  });

  it("ignores unknown events", async () => {
    const cat = new Catalogue(new Store(":memory:"), null);
    expect(await runHook({ hook_event_name: "SessionStart" }, cat)).toBeNull();
  });

  it("formatContext is compact and deterministic", () => {
    const text = formatContext(
      [
        {
          id: "x_1",
          kind: "episode",
          problem: "P",
          fix: "F",
          avoid: ["A1", "A2"],
          context: [],
          outcome: "failure",
          confidence: 0.25,
          uses: 2,
          match: { score: 0.61, exact: false, via: ["lexical"] },
        },
      ],
      10,
      false
    )!;
    expect(text).toBe(
      "learned-experience: 1 past experience matches this failure.\n" +
        "1. [x_1] P | fix: F | avoid: A1; A2 | (confidence 0.25, score 0.61, unresolved last time)\n" +
        "Check applicability first. Before trying a fix call begin_attempt with a shared execution identity, then feedback with the returned revision/attempt and checked evidence. Legacy reinforce remains available for unverified reports. If none fit and you solve it another way, call `record` once. If a hit is clearly unrelated, call `dismiss` with its id and this problem so it stops appearing here."
    );
  });
});

describe("UserPromptSubmit hook", () => {
  it("skips short prompts and slash commands", () => {
    expect(queryFromPrompt("yes")).toBeNull();
    expect(queryFromPrompt("/commit all the things please")).toBeNull();
    expect(queryFromPrompt("   ")).toBeNull();
  });

  it("uses the request as the problem and error-like lines as signals", () => {
    const q = queryFromPrompt("Fix the deploy, it keeps failing:\nError: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/x'\nthanks")!;
    expect(q.problem.startsWith("Fix the deploy")).toBe(true);
    expect(q.signals).toContain("Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/x'");
    expect(q.signals).not.toContain("thanks");
    expect(q.context).toEqual([]);
  });

  it("injects relevant experience for a request, and stays silent on a miss", async () => {
    const cat = new Catalogue(new Store(":memory:"), new FakeEmbedder());
    await cat.record({
      problem: "Vite dev server does not hot-reload inside Docker on macOS",
      signals: [],
      context: ["vite", "docker", "macos"],
      fix: "Set server.watch.usePolling = true in vite.config.ts",
      avoid: [],
      outcome: "success",
      kind: "episode",
      attempts: [],
    });
    const hit = (await runHook({ hook_event_name: "UserPromptSubmit", prompt: "The vite dev server in my docker container is not hot reloading on my mac, can you fix it" }, cat))!;
    const ctx = hit.hookSpecificOutput as { hookEventName: string; additionalContext: string };
    expect(ctx.hookEventName).toBe("UserPromptSubmit");
    expect(ctx.additionalContext).toContain("looks relevant to this request");
    expect(ctx.additionalContext).toContain("usePolling");
    expect(await runHook({ hook_event_name: "UserPromptSubmit", prompt: "Write a haiku about the ocean and the moon for me" }, cat)).toBeNull();
  });
});

describe("Stop hook", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const user = (text: string) => line({ type: "user", message: { role: "user", content: text } });
  const toolUse = (name: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] } });
  const result = (isError: boolean) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: isError, content: "x" }] } });

  it("summarises only the last turn", () => {
    const jsonl = [
      user("first request"),
      toolUse("Bash"),
      result(true),
      user("second request"),
      toolUse("Bash"),
      result(true),
      toolUse("Bash"),
      result(false),
      toolUse("mcp__plugin_learned-experience_learned-experience__recall"),
      result(false),
      "not json at all",
    ].join("\n");
    expect(summarizeLastTurn(jsonl)).toEqual({ toolCalls: 3, failures: 1, recorded: false, recalled: true });
  });

  it("asks once for a record only when explicitly enabled, and never loops", async () => {
    const jsonl = [user("fix the build"), toolUse("Bash"), result(true), toolUse("Edit"), result(false), toolUse("Bash"), result(false)].join("\n");
    const cat = new Catalogue(new Store(":memory:"), null);
    const readTranscript = async () => jsonl;
    const out = (await runHook({ hook_event_name: "Stop", transcript_path: "/x", stop_hook_active: false }, cat, { readTranscript, stopNudge: true }))!;
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/1 failed tool call across 3 calls/);
    expect(out.reason).toContain("`record`");
    expect(await runHook({ hook_event_name: "Stop", transcript_path: "/x", stop_hook_active: true }, cat, { readTranscript, stopNudge: true })).toBeNull();
    expect(await runHook({ hook_event_name: "Stop", transcript_path: "/x" }, cat, { readTranscript, stopNudge: false })).toBeNull();
  });

  it("stays quiet for uneventful turns and when the model already recorded", () => {
    expect(stopDecision({ toolCalls: 2, failures: 1, recorded: false, recalled: false }, {})).toBeNull();
    expect(stopDecision({ toolCalls: 5, failures: 0, recorded: false, recalled: false }, {})).toBeNull();
    expect(stopDecision({ toolCalls: 5, failures: 2, recorded: true, recalled: true }, {})).toBeNull();
    expect(stopDecision({ toolCalls: 15, failures: 0, recorded: false, recalled: false }, {})?.reason).toMatch(/15 tool calls/);
    expect(stopDecision({ toolCalls: 4, failures: 1, recorded: false, recalled: true }, {})?.reason).toContain("`reinforce`");
  });

  it("reads thresholds from the environment", () => {
    expect(hookOptionsFromEnv({ LEARNED_EXPERIENCE_STOP_NUDGE: "0", LEARNED_EXPERIENCE_STOP_MIN_CALLS: "7", LEARNED_EXPERIENCE_HOOK_QUIET: "1" })).toMatchObject({
      stopNudge: false,
      stopMinToolCalls: 7,
      quietOnMiss: true,
    });
    expect(hookOptionsFromEnv({})).toMatchObject({ stopNudge: false, quietOnMiss: false });
    expect(hookOptionsFromEnv({ LEARNED_EXPERIENCE_STOP_NUDGE: "1" }).stopNudge).toBe(true);
    expect(hookOptionsFromEnv({ LEARNED_EXPERIENCE_STOP_NUDGE: "true" }).stopNudge).toBe(false);
  });

  it("does not read the transcript or block a completed answer by default", async () => {
    const cat = new Catalogue(new Store(":memory:"), null);
    const readTranscript = async () => { throw new Error("disabled Stop must not read transcripts"); };
    const input = { hook_event_name: "Stop", transcript_path: "/completed-answer.jsonl" };
    expect(await runHook(input, cat, { readTranscript })).toBeNull();
    expect(await runHook(input, cat, { ...hookOptionsFromEnv({}), readTranscript })).toBeNull();
  });

  it("preserves a Codex final answer after the reported one-failure ten-call turn", async () => {
    const jsonl = [
      line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Research API key services" }] } }),
      ...Array.from({ length: 10 }, (_, i) => [
        line({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "research" } }),
        line({ type: "response_item", payload: { type: "custom_tool_call_output", output: JSON.stringify({ exit_code: i === 0 ? 1 : 0 }) } }),
      ]).flat(),
      line({ type: "response_item", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "Here are the research results." }] } }),
    ].join("\n");
    expect(summarizeLastTurn(jsonl)).toMatchObject({ toolCalls: 10, failures: 1, recorded: false });
    const cat = new Catalogue(new Store(":memory:"), null);
    const input = { hook_event_name: "Stop", transcript_path: "/codex-rollout.jsonl" };
    const readTranscript = async () => jsonl;
    expect(await runHook(input, cat, { readTranscript })).toBeNull();
    expect(await runHook(input, cat, { ...hookOptionsFromEnv({}), readTranscript })).toBeNull();
    expect((await runHook(input, cat, { readTranscript, stopNudge: true }))?.decision).toBe("block");
  });
});

describe("Codex support", () => {
  it("looksFailed detects explicit flags, exit fields and unmistakable text, but not the word error", () => {
    expect(looksFailed({ output: "ok", metadata: { exit_code: 0 } })).toBe(false);
    expect(looksFailed({ output: "boom", metadata: { exit_code: 2 } })).toBe(true);
    expect(looksFailed({ is_error: true })).toBe(true);
    expect(looksFailed("Command exited with code 1")).toBe(true);
    expect(looksFailed([{ type: "input_text", text: "Script failed\nTraceback (most recent call last):" }])).toBe(true);
    expect(looksFailed('{"output":"done","metadata":{"exit_code":0}}')).toBe(false);
    expect(looksFailed('{"output":"...","metadata":{"exit_code":127}}')).toBe(true);
    expect(looksFailed("grep found 3 lines containing the word error")).toBe(false);
    expect(looksFailed("fine", "Command exited with code 1")).toBe(true);
    expect(looksFailed(null)).toBe(false);
  });

  it("PostToolUse fires only for responses that look like failures", async () => {
    const cat = new Catalogue(new Store(":memory:"), null);
    const ok = await runHook({ hook_event_name: "PostToolUse", tool_name: "shell", tool_input: { command: ["ls"] }, tool_response: { output: "a\nb", metadata: { exit_code: 0 } } }, cat);
    expect(ok).toBeNull();
    const bad = (await runHook(
      { hook_event_name: "PostToolUse", tool_name: "shell", tool_input: { command: "npm test" }, tool_response: { output: "Error: Cannot find module vitest", metadata: { exit_code: 1 } } },
      cat
    ))!;
    expect((bad.hookSpecificOutput as { hookEventName: string }).hookEventName).toBe("PostToolUse");
    expect((bad.hookSpecificOutput as { additionalContext: string }).additionalContext).toMatch(/no past experience/);
  });

  it("summarises the last turn of a Codex rollout", () => {
    const l = (o: unknown) => JSON.stringify(o);
    const jsonl = [
      l({ type: "session_meta", payload: {} }),
      l({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old request" }] } }),
      l({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } }),
      l({ type: "response_item", payload: { type: "function_call_output", output: '{"output":"x","metadata":{"exit_code":1}}' } }),
      l({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new request" }] } }),
      l({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "..." } }),
      l({ type: "response_item", payload: { type: "custom_tool_call_output", output: [{ type: "input_text", text: "Script failed\nOutput:\nboom" }] } }),
      l({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } }),
      l({ type: "response_item", payload: { type: "function_call_output", output: '{"output":"ok","metadata":{"exit_code":0}}' } }),
      l({ type: "response_item", payload: { type: "function_call", name: "mcp__learned-experience__record", arguments: "{}" } }),
      l({ type: "response_item", payload: { type: "function_call_output", output: '{"id":"x_1"}' } }),
      l({ type: "event_msg", payload: { type: "token_count" } }),
    ].join("\n");
    expect(summarizeLastTurn(jsonl)).toEqual({ toolCalls: 3, failures: 1, recorded: true, recalled: false });
  });
});

describe("Gemini CLI support", () => {
  it("AfterTool fires on an error field and BeforeAgent recalls by prompt, emitting top-level additionalContext too", async () => {
    const cat = new Catalogue(new Store(":memory:"), new FakeEmbedder());
    await cat.record({
      problem: "Vite dev server does not hot-reload inside Docker on macOS",
      signals: [],
      context: ["vite", "docker"],
      fix: "Set server.watch.usePolling = true",
      avoid: [],
      outcome: "success",
      kind: "episode",
      attempts: [],
    });
    const ok = await runHook({ hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: {}, tool_response: { llmContent: "done", returnDisplay: "done" } }, cat);
    expect(ok).toBeNull();
    const bad = (await runHook(
      { hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "npm test" }, tool_response: { llmContent: "Error: Cannot find module vitest", returnDisplay: "", error: { message: "Command failed" } } },
      cat
    ))!;
    expect(bad.additionalContext).toMatch(/no past experience/);
    expect((bad.hookSpecificOutput as { hookEventName: string }).hookEventName).toBe("AfterTool");
    const before = (await runHook({ hook_event_name: "BeforeAgent", prompt: "the vite dev server in docker on my mac is not hot reloading, please fix" }, cat))!;
    expect(before.additionalContext).toContain("usePolling");
    expect((before.hookSpecificOutput as { hookEventName: string }).hookEventName).toBe("BeforeAgent");
  });
});
