import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { formatContext, queryFromFailure, responseText, runHook } from "../src/hook.js";
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
    expect(queryFromFailure({ tool_name: "mcp__been-there__recall", error: "boom failed" })).toBeNull();
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
    expect(await runHook({ tool_name: "mcp__been-there__record", error: "x failed" }, cat)).toBeNull();
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
      "been-there: 1 past experience matches this failure.\n" +
        "1. [x_1] P | fix: F | avoid: A1; A2 | (confidence 0.25, score 0.61, unresolved last time)\n" +
        "Apply the best-fitting fix first, then call been-there `reinforce` with its id and whether it worked. If none fit and you solve it another way, call `record` once."
    );
  });
});
