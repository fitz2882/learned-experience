/** End-to-end quality and compatibility checks against the built MCP server and real local embedder. */
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Ajv from "ajv";

const data = mkdtempSync(join(tmpdir(), "le-quality-"));
const cache = join(homedir(), ".learned-experience", "models");
if (existsSync(cache)) cpSync(cache, join(data, "models"), { recursive: true });
const entry = resolve(process.argv[2] ?? "dist/index.js");
const env = {
  ...process.env,
  LEARNED_EXPERIENCE_HOME: data,
  LEARNED_EXPERIENCE_DB: join(data, "experiences.db"),
  LEARNED_EXPERIENCE_EMBEDDINGS: "local",
  LEARNED_EXPERIENCE_MAINTENANCE: "0",
};
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", (d) => {
  stderr += d.toString();
});
const client = new Client({ name: "quality-replay", version: "1" });
const started = Date.now();
await client.connect(transport);
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
};
const evidence = {
  summary: "Regression replay confirmed the expected behavior",
  reference: "quality-replay.json",
  observed_at: new Date().toISOString(),
  level: "local-test",
};
const checks = [];
try {
  const auto = await call("record", {
    problem: "Debounced autosave loses answers when navigating or overlapping writes",
    signals: ["Older save response overwrote newer draft"],
    context: ["javascript", "autosave", "browser"],
    fix: "Capture drafts on input, serialize saves per item and await pending writes before navigation.",
    outcome: "success",
  });
  const pg = await call("record", {
    problem: "Cannot connect to local Postgres after reboot",
    signals: ["Error: connect ECONNREFUSED 127.0.0.1:5432"],
    context: ["postgres", "macos"],
    fix: "Start the local database service after verifying it is stopped.",
    outcome: "success",
  });
  const plugin = await call("record", {
    problem: "Claude Code plugin fails to load with a duplicate hooks file error",
    signals: ["Duplicate hooks file detected"],
    context: ["claude-code", "plugin"],
    fix: "Remove duplicated registration of automatically loaded hook files.",
    outcome: "success",
  });
  const cases = [
    { problem: "An autosave response overwrites a newer answer after navigation", context: ["javascript"], expected: auto.id },
    { problem: "Postgres database connection refused after restarting the machine", context: ["postgres"], expected: pg.id },
    { problem: "Plugin load failed because hooks were registered twice", context: ["plugin"], expected: plugin.id },
    {
      problem: "Python pandas merge duplicates rows when the lookup table has duplicate keys",
      context: ["python", "pandas"],
      expected: null,
    },
    { problem: "Bread dough fails to rise in a cold kitchen", context: ["baking"], expected: null },
    { problem: "Spreadsheet chart labels overlap when resizing a pie chart", context: ["excel"], expected: null },
  ];
  for (const q of cases) {
    const { expected, ...query } = q;
    const result = await call("recall", query);
    assert.equal(result.hits[0]?.id ?? null, expected, q.problem);
    checks.push({ check: q.problem, passed: true, hits: result.hits.length });
  }
  const receipt = await call("begin_attempt", { id: pg.id, execution_id: "one-database-test", environment: { platform: "macos" } });
  delete receipt.instruction;
  const vote = { ...receipt, result: "verified-success", evidence };
  await call("feedback", vote);
  await call("feedback", vote);
  assert.equal((await call("inspect", { id: pg.id })).evidence.successes, 1);
  const prior = await call("inspect", { id: pg.id });
  await call("amend", {
    id: pg.id,
    expected_revision: prior.revision,
    patch: { fix: "Correct the socket path after verifying the database is running." },
  });
  assert.equal((await call("inspect", { id: pg.id })).evidence.successes, 0);
  checks.push({ check: "duplicate votes and revision-bound reliability", passed: true });
  const old = await call("record", {
    problem: "Example host rejects top-level additional context",
    signals: ["additionalContext forbidden"],
    fix: "Emit both context locations",
    outcome: "success",
    applicability: { product: "example-host", version: "2" },
    claims: [{ key: "context-output", value: "both" }],
  });
  const corrected = await call("record", {
    problem: "Example host rejects top-level additional context",
    signals: ["additionalContext forbidden"],
    fix: "Emit only hookSpecificOutput.additionalContext",
    outcome: "success",
    applicability: { product: "example-host", version: "2" },
    claims: [{ key: "context-output", value: "nested" }],
  });
  const ajv = new Ajv();
  const schema = JSON.parse(readFileSync("test/fixtures/codex/post-tool-use.command.output.schema.json", "utf8"));
  assert.equal(
    ajv.validate(schema, { additionalContext: "x", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } }),
    false,
  );
  assert.equal(ajv.validate(schema, { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } }), true);
  await call("maintenance", { mode: "run", limit: 100 });
  const jobs = (await call("maintenance", { mode: "queue", limit: 100 })).jobs;
  const conflict = jobs.find((j) => j.kind === "conflict" && [j.id, j.related_id].includes(old.id));
  assert.ok(conflict);
  await call("maintenance", {
    mode: "resolve",
    key: conflict.key,
    action: "supersede",
    winner_id: corrected.id,
    evidence: { ...evidence, reference: "test/fixtures/codex/post-tool-use.command.output.schema.json" },
  });
  const current = await call("recall", {
    problem: "Example host rejects top-level additional context",
    signals: ["additionalContext forbidden"],
    environment: { product: "example-host", version: "2" },
  });
  assert.equal(current.hits[0].id, corrected.id);
  assert.ok(!current.hits.some((h) => h.id === old.id));
  checks.push({ check: "evidence-backed correction suppresses superseded advice", passed: true });
  for (const event of ["PostToolUse", "UserPromptSubmit", "Stop"]) {
    const result = spawnSync(process.execPath, [entry, "hook", "--codex"], {
      env,
      input: JSON.stringify({
        hook_event_name: event,
        turn_id: "quality-turn",
        tool_name: "shell",
        tool_response: { exit_code: 1, output: "Duplicate hooks file detected" },
        prompt: "Claude Code plugin fails to load with a duplicate hooks file error",
      }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    if (event === "Stop") assert.equal(result.stdout, "");
    else {
      const out = JSON.parse(result.stdout);
      const fixture = event === "PostToolUse" ? "post-tool-use" : "user-prompt-submit";
      assert.equal(
        ajv.validate(JSON.parse(readFileSync(`test/fixtures/codex/${fixture}.command.output.schema.json`, "utf8")), out),
        true,
        JSON.stringify(ajv.errors),
      );
      assert.ok(out.hookSpecificOutput.additionalContext.includes("duplicated registration"));
    }
    checks.push({ check: `built ${event} hook`, passed: true });
  }
  const stats = await call("stats");
  assert.equal(stats.embedding_error, null);
  assert.equal(stats.embedded, stats.records);
  const report = {
    passed: true,
    checks,
    elapsed_ms: Date.now() - started,
    records: stats.records,
    embedding_model: stats.embedding_model,
    data_dir: data,
  };
  writeFileSync(join(data, "quality-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  await client.close();
}
