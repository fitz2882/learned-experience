import { afterEach, describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { actionKey, runHook } from "../src/hook.js";
import { applicabilityMatch, canonicalProject, projectFromCwd } from "../src/learning.js";
import { Store } from "../src/store.js";
import type { ExperienceInput } from "../src/schema.js";
import { FakeEmbedder } from "./fake-embedder.js";

const start = Date.parse("2026-11-01T12:00:00.000Z");
const lesson: ExperienceInput = {
  problem: "Global npm install fails with EACCES permission denied",
  signals: ["npm ERR! code EACCES"],
  context: ["npm"],
  attempts: [],
  fix: "npm config set prefix ~/.npm-global and add its bin folder to PATH",
  avoid: ["sudo npm install -g"],
  outcome: "success",
  kind: "episode",
};
const evidence = (at: string) => ({
  summary: "Previously failing install succeeds after applying the fix",
  reference: "test-run:usage/report.json",
  observed_at: at,
  level: "local-test" as const,
});

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function make(opts: { budget?: number; archiveDays?: number } = {}) {
  const store = new Store(":memory:");
  stores.push(store);
  const clock = { now: start };
  const cat = new Catalogue(store, new FakeEmbedder(), {
    now: () => new Date(clock.now),
    recordBudget: opts.budget,
    archiveDays: opts.archiveDays,
  });
  return { store, cat, clock };
}

const failure = {
  hook_event_name: "PostToolUseFailure",
  session_id: "session-1",
  cwd: "/tmp",
  tool_name: "Bash",
  tool_input: { command: "npm  install -g typescript" },
  error: "Command exited with code 243",
  tool_response: "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
};
const success = {
  hook_event_name: "PostToolUse",
  session_id: "session-1",
  cwd: "/tmp",
  tool_name: "Bash",
  tool_input: { command: "npm install -g   typescript" },
  tool_response: { stdout: "added 1 package", exit_code: 0 },
};

describe("usage log", () => {
  it("records what a hook showed as hashes and ids, and reports it in stats", async () => {
    const { store, cat } = make();
    const r = await cat.record(lesson);
    await runHook(failure, cat);
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", prompt: "Please write a haiku about autumn leaves" }, cat);
    const events = store.recallEvents("2000-01-01T00:00:00.000Z");
    expect(events.map((e) => e.hits.map((h) => h.id))).toEqual([[r.id], []]);
    const raw = JSON.stringify(events);
    expect(raw).not.toMatch(/EACCES|haiku|session-1/);
    const usage = (await cat.stats()).usage as Record<string, unknown>;
    expect(usage).toMatchObject({ recalls_30d: 2, recalls_with_hits_30d: 1, hit_rate_30d: 0.5, lessons_shown_ever: 1, lessons_never_shown: 0 });
    expect(usage.top_shown_30d).toEqual([{ id: r.id, shown: 1, problem: lesson.problem }]);
  });

  it("does not log plain recall calls that do not ask for it", async () => {
    const { store, cat } = make();
    await cat.record(lesson);
    await cat.recall({ problem: "npm", signals: lesson.signals });
    expect(store.recallEvents("2000-01-01T00:00:00.000Z")).toHaveLength(0);
  });
});

describe("helped follow-up", () => {
  it("asks once when the same failing call later succeeds, and counts it as likely helped", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    expect(actionKey(failure)).toBe(actionKey(success));
    await runHook(failure, cat);
    const out = (await runHook(success, cat)) as { additionalContext: string };
    expect(out.additionalContext).toContain(`[${r.id}]`);
    expect(out.additionalContext).toMatch(/now succeeds/);
    expect(await runHook(success, cat)).toBeNull();
    expect(((await cat.stats()).usage as Record<string, unknown>).likely_helped_30d).toBe(1);
  });

  it("stays silent for a different session, a different call, or when nothing was shown", async () => {
    const { cat } = make();
    await cat.record(lesson);
    await runHook(failure, cat);
    expect(await runHook({ ...success, session_id: "session-2" }, cat)).toBeNull();
    expect(await runHook({ ...success, tool_input: { command: "npm test" } }, cat)).toBeNull();
    const empty = make();
    await runHook(failure, empty.cat);
    expect(await runHook(success, empty.cat)).toBeNull();
  });

  it("can be turned off", async () => {
    const { cat } = make();
    await cat.record(lesson);
    await runHook(failure, cat);
    expect(await runHook(success, cat, { helpedNudge: false })).toBeNull();
  });
});

describe("record gate", () => {
  it("rejects a lesson with neither a fix nor an error signal", async () => {
    const { cat } = make();
    await expect(cat.record({ ...lesson, fix: "", signals: [], outcome: "partial" })).rejects.toThrow(/fix or at least one exact error signal/);
    expect((await cat.record({ ...lesson, fix: "", outcome: "partial" })).action).toBe("created");
  });

  it("skips new lessons past the hourly budget but still merges duplicates", async () => {
    const { cat, clock } = make({ budget: 2 });
    await cat.record(lesson);
    await cat.record({ ...lesson, problem: "Docker build cannot reach registry", signals: ["dial tcp: i/o timeout"], fix: "Set the proxy in daemon.json", context: ["docker"] });
    const skipped = await cat.record({ ...lesson, problem: "Gradle daemon crashes", signals: ["Gradle build daemon disappeared"], fix: "Raise org.gradle.jvmargs", context: ["gradle"] });
    expect(skipped).toMatchObject({ action: "skipped" });
    expect(skipped.reason).toMatch(/budget 2/);
    expect((await cat.record(lesson)).action).toBe("merged");
    clock.now += 3600001;
    expect((await cat.record({ ...lesson, problem: "Gradle daemon crashes", signals: ["Gradle build daemon disappeared"], fix: "Raise org.gradle.jvmargs", context: ["gradle"] })).action).toBe("created");
  });

  it("has no budget when set to zero", async () => {
    const { cat } = make({ budget: 0 });
    for (let i = 0; i < 15; i++)
      expect((await cat.record({ ...lesson, problem: `distinct problem ${i} zz${i}`, signals: [`unique signal ${i} qq${i}`], fix: `fix ${i} ww${i}`, context: [`t${i}`] })).action).not.toBe("skipped");
  });
});

describe("project names", () => {
  it("treats different spellings of one project as the same", () => {
    expect(canonicalProject("~/vesper root/personal projects/capability atlas")).toBe("capability-atlas");
    expect(canonicalProject("Capability Atlas")).toBe("capability-atlas");
    expect(canonicalProject("capability_atlas/")).toBe("capability-atlas");
    expect(canonicalProject("design space")).toBe(canonicalProject("design-space"));
    expect(applicabilityMatch({ project: "capability atlas" }, { project: "/Users/x/Personal Projects/Capability Atlas" })).toBe("match");
    expect(applicabilityMatch({ project: "capability atlas" }, { project: "design-space" })).toBe("mismatch");
  });

  it("finds the repository folder above the working folder", () => {
    const exists = (p: string) => p === "/home/u/Code/Loopgain Studio/.git";
    expect(projectFromCwd("/home/u/Code/Loopgain Studio/src/app", exists)).toBe("loopgain-studio");
    expect(projectFromCwd("/tmp/scratch dir", () => false)).toBe("scratch-dir");
    expect(projectFromCwd(undefined)).toBeUndefined();
  });

  it("ranks lessons from the current project first without hiding others", async () => {
    const { cat } = make();
    const other = await cat.record({ ...lesson, applicability: { project: "alpha" } });
    const mine = await cat.record({ ...lesson, fix: "Use a Node version manager so global installs land in your home folder", applicability: { project: "Beta Project" } });
    const hits = (await cat.recall({ problem: lesson.problem, signals: lesson.signals, prefer_project: "/work/beta_project" })).hits.map((h) => h.id);
    expect(hits).toEqual([mine.id, other.id]);
    const plain = (await cat.recall({ problem: lesson.problem, signals: lesson.signals, prefer_project: "alpha" })).hits.map((h) => h.id);
    expect(plain[0]).toBe(other.id);
  });
});

describe("archive", () => {
  it("keeps long-unused lessons out of fuzzy results but returns them on an exact match", async () => {
    const { cat, clock } = make({ archiveDays: 90 });
    const r = await cat.record(lesson);
    await cat.recall({ problem: "warm up", log: { origin: "cli" } }); // starts the usage log
    const fuzzy = { problem: "global npm install EACCES permission denied error", min_score: 0.3 };
    expect((await cat.recall(fuzzy)).hits.map((h) => h.id)).toEqual([r.id]);
    clock.now += 91 * 86400000;
    expect((await cat.recall(fuzzy)).hits).toEqual([]);
    expect((await cat.recall({ ...fuzzy, include_archived: true })).hits.map((h) => h.id)).toEqual([r.id]);
    expect((await cat.recall({ problem: "npm", signals: lesson.signals })).hits.map((h) => h.id)).toEqual([r.id]);
    expect(((await cat.stats()).usage as Record<string, unknown>).archived).toBe(1);
  });

  it("never archives anything until the usage log is older than the archive window", async () => {
    const { cat, clock } = make({ archiveDays: 90 });
    const r = await cat.record(lesson);
    clock.now += 200 * 86400000;
    await cat.recall({ problem: "first logged recall", log: { origin: "cli" } });
    expect((await cat.recall({ problem: "global npm install EACCES permission denied error", min_score: 0.3 })).hits.map((h) => h.id)).toEqual([r.id]);
  });

  it("keeps a lesson active while it is being shown", async () => {
    const { cat, clock } = make({ archiveDays: 90 });
    const r = await cat.record(lesson);
    await cat.recall({ problem: "warm up", log: { origin: "cli" } });
    clock.now += 60 * 86400000;
    await cat.recall({ problem: "npm", signals: lesson.signals, log: { origin: "hook" } });
    clock.now += 60 * 86400000;
    expect((await cat.recall({ problem: "global npm install EACCES permission denied error", min_score: 0.3 })).hits.map((h) => h.id)).toEqual([r.id]);
  });
});

describe("maintenance queue", () => {
  it("does not queue unverified version-specific advice and suggests a rule for cross-project lessons", async () => {
    const { cat, clock } = make();
    const versioned = await cat.record({ ...lesson, applicability: { version: "10.2.0" } });
    const general = await cat.record({ ...lesson, problem: "Python interpreter lacks PyYAML for a validator", signals: ["ModuleNotFoundError: No module named 'yaml'"], fix: "Run the validator with an interpreter that has PyYAML", context: ["python"] });
    for (const [run, project] of [["run-a", "alpha"], ["run-b", "Beta Project"]] as const) {
      const receipt = await cat.beginAttempt(general.id, run, { project });
      await cat.feedback({ ...receipt, result: "verified-success", evidence: evidence(new Date(clock.now).toISOString()) });
    }
    await cat.maintain(50, 1000);
    const kinds = cat.maintenanceQueue(50).map((j) => [j.kind, j.id]);
    expect(kinds).not.toContainEqual(["unverified", versioned.id]);
    expect(kinds).toContainEqual(["promote", general.id]);
    expect(((await cat.stats()).usage as Record<string, unknown>).verified_in_two_or_more_projects).toBe(1);
  });
});
