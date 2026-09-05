import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
