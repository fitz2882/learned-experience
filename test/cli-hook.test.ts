import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([undefined, "0", "true"])("Stop CLI emits no continuation or catalogue files with nudge=%s", (nudge) => {
  const dir = mkdtempSync(join(tmpdir(), "le-stop-"));
  try {
    const dbPath = join(dir, "data", "experiences.db");
    const env = { ...process.env, LEARNED_EXPERIENCE_HOME: join(dir, "data"), LEARNED_EXPERIENCE_DB: dbPath };
    delete env.LEARNED_EXPERIENCE_STOP_NUDGE;
    if (nudge !== undefined) env.LEARNED_EXPERIENCE_STOP_NUDGE = nudge;
    const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "hook"], {
      env,
      input: JSON.stringify({ hook_event_name: "Stop", transcript_path: join(dir, "missing-rollout.jsonl") }),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(dbPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("CLI sends one non-blocking reminder across processes and leaves Stop silent", () => {
  const dir = mkdtempSync(join(tmpdir(), "le-cli-reminder-"));
  try {
    const transcript = join(dir, "rollout.jsonl");
    const row = (payload: unknown) => JSON.stringify({ type: "response_item", payload });
    writeFileSync(transcript, [
      row({ type: "message", role: "user", content: [{ type: "input_text", text: "Fix the failing tests" }] }),
      ...Array.from({ length: 3 }, (_, i) => [
        row({ type: "custom_tool_call", name: "exec", input: "test" }),
        row({ type: "custom_tool_call_output", output: JSON.stringify({ exit_code: i === 0 ? 1 : 0 }) }),
      ]).flat(),
    ].join("\n"));
    const env = { ...process.env, LEARNED_EXPERIENCE_HOME: dir, LEARNED_EXPERIENCE_DB: join(dir, "experiences.db"), LEARNED_EXPERIENCE_EMBEDDINGS: "none" };
    for (const key of ["LEARNED_EXPERIENCE_STOP_NUDGE", "LEARNED_EXPERIENCE_RECORD_NUDGE", "LEARNED_EXPERIENCE_RECORD_MIN_FAILURES", "LEARNED_EXPERIENCE_RECORD_MIN_CALLS", "LEARNED_EXPERIENCE_RECORD_LONG_TURN"]) delete env[key];
    const run = (event: string) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "hook"], {
        env,
        input: JSON.stringify({ hook_event_name: event, transcript_path: transcript, tool_name: "Bash", tool_response: { exit_code: 0 } }),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const first = JSON.parse(run("PostToolUse"));
    expect(first.decision).toBeUndefined();
    expect(first.continue).toBeUndefined();
    expect(first.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(first.hookSpecificOutput.additionalContext).toContain("before your final answer");
    expect(run("PostToolUse")).toBe("");
    expect(run("Stop")).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
