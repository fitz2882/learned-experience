import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalogue } from "../src/catalogue.js";
import { Store } from "../src/store.js";
import { revisionOf, evidenceSummary } from "../src/learning.js";
import { startMaintenanceWorker } from "../src/worker.js";
import type { ExperienceInput, FeedbackInput } from "../src/schema.js";

const time = "2026-09-09T12:00:00.000Z";
const evidence = {
  summary: "Previously failing regression passes after applying this fix",
  reference: "test-run:abc/report.json",
  observed_at: time,
  level: "local-test" as const,
};
const lesson: ExperienceInput = {
  problem: "Application cannot connect to local Postgres",
  signals: ["ECONNREFUSED localhost:5432"],
  context: ["postgres"],
  attempts: [],
  fix: "Start the local Postgres service with brew services start postgresql",
  avoid: ["Reinstalling the application"],
  outcome: "success",
  kind: "episode",
};
const stores: Store[] = [];
const dirs: string[] = [];
function make(file = ":memory:") {
  const store = new Store(file);
  stores.push(store);
  return { store, cat: new Catalogue(store, null, { now: () => new Date(time) }) };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
async function vote(cat: Catalogue, id: string, execution: string, result: FeedbackInput["result"] = "verified-success") {
  const receipt = await cat.beginAttempt(id, execution, {});
  return cat.feedback({ ...receipt, result, evidence });
}

describe("verification votes", () => {
  it("counts one execution once across observers and promotes independent verified applications", async () => {
    const { cat } = make();
    const a = await cat.record(lesson);
    const b = await cat.record({ ...lesson, fix: "Change the database connection port" });
    await vote(cat, a.id, "run-one");
    await vote(cat, a.id, "run-one");
    await vote(cat, a.id, "run-two");
    await vote(cat, b.id, "run-three", "verified-failure");
    const hits = (await cat.recall({ problem: "db", signals: lesson.signals })).hits;
    expect(hits.map((h) => h.id)).toEqual([a.id, b.id]);
    expect(hits[0].evidence).toMatchObject({ successes: 2, failures: 0 });
    expect(hits[0].confidence).toBe(0.75);
    expect((await cat.get(a.id))!.votes).toHaveLength(2);
  });
  it("rejects conflicting reports about the same execution", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    await vote(cat, r.id, "same");
    await expect(vote(cat, r.id, "same", "verified-failure")).rejects.toThrow(/already has different/);
  });
  it("legacy applause and diagnostic help do not become verification", async () => {
    const { cat } = make();
    const r = await cat.record({ ...lesson, fix: "", outcome: "partial" });
    await cat.reinforce(r.id, true);
    await cat.reinforce(r.id, true);
    await vote(cat, r.id, "diagnosis", "diagnostic-help");
    const hit = (await cat.recall({ problem: "db", signals: lesson.signals })).hits[0];
    expect(hit.confidence).toBe(0);
    expect(hit.recommendation).toBe("diagnostic-lead");
    expect(hit.evidence).toMatchObject({ successes: 0, diagnostic_helps: 1 });
    await expect(vote(cat, r.id, "pretend-success")).rejects.toThrow(/empty fix/);
  });
  it("requires real verification fields and matching explicit scope", async () => {
    const { cat } = make();
    const r = await cat.record({
      ...lesson,
      applicability: { product: "postgres", version: "16", platform: "macos" },
      preconditions: ["Confirm the service is stopped"],
    });
    await expect(cat.beginAttempt(r.id, "x", { platform: "linux" })).rejects.toThrow(/matching/);
    const receipt = await cat.beginAttempt(r.id, "x", { product: "postgres", version: "16", platform: "macos" });
    await expect(cat.feedback({ ...receipt, result: "verified-success" })).rejects.toThrow(/requires/);
    await expect(cat.feedback({ ...receipt, result: "verified-success", evidence: { ...evidence, level: "reported" } })).rejects.toThrow(
      /requires/,
    );
    await expect(cat.feedback({ ...receipt, result: "verified-success", environment: {}, evidence })).rejects.toThrow(/environment/);
    await cat.feedback({ ...receipt, result: "verified-success", evidence });
    expect(
      (await cat.recall({ problem: lesson.problem, environment: { product: "postgres", version: "17", platform: "macos" } })).hits,
    ).toHaveLength(0);
    const unknown = (await cat.recall({ problem: lesson.problem })).hits[0];
    expect(unknown.applicability).toBe("unknown");
    expect(unknown.constraints).toEqual({ product: "postgres", version: "16", platform: "macos" });
    expect(unknown.preconditions).toEqual(["Confirm the service is stopped"]);
  });
  it("a changed remedy cannot inherit votes, and can be restored without losing history", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    await vote(cat, r.id, "first");
    const prior = (await cat.get(r.id))!;
    const rev = revisionOf(prior);
    const changed = await cat.amend(r.id, { fix: "Correct the port mapping instead" }, rev);
    expect(evidenceSummary(changed).successes).toBe(0);
    expect(changed.votes).toHaveLength(1);
    await expect(cat.amend(r.id, { fix: "stale edit" }, rev)).rejects.toThrow(/revision changed/);
    const restored = await cat.restore(r.id, rev, revisionOf(changed), "Undo a mistaken amendment");
    expect(restored.fix).toBe(lesson.fix);
    expect(evidenceSummary(restored).successes).toBe(1);
    expect(restored.history!.length).toBeGreaterThanOrEqual(2);
  });
  it("preserves late feedback on the original revision without crediting the replacement", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    const receipt = await cat.beginAttempt(r.id, "long-test", {});
    await cat.amend(r.id, { fix: "Change socket configuration" });
    await cat.feedback({ ...receipt, result: "verified-success", evidence });
    expect(evidenceSummary((await cat.get(r.id))!).successes).toBe(0);
  });
  it("separates irrelevant retrieval feedback from solution reliability", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    await vote(cat, r.id, "test");
    const before = (await cat.recall({ problem: lesson.problem })).hits[0];
    const receipt = await cat.beginAttempt(r.id, "unrelated-query", {});
    await cat.feedback({ ...receipt, result: "irrelevant", problem: "postgres connection diagram", signals: [] });
    expect((await cat.recall({ problem: "postgres connection diagram" })).hits).toHaveLength(0);
    const after = (await cat.recall({ problem: lesson.problem })).hits[0];
    expect(after.confidence).toBe(before.confidence);
    expect(after.match.score).toBe(before.match.score);
  });
  it("redacts evidence and rejects future observations", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    const receipt = await cat.beginAttempt(r.id, "run", {});
    await expect(
      cat.feedback({ ...receipt, result: "verified-success", evidence: { ...evidence, observed_at: "2030-01-01T00:00:00Z" } }),
    ).rejects.toThrow(/future/);
    await cat.feedback({
      ...receipt,
      result: "verified-success",
      evidence: {
        ...evidence,
        summary: "Verified using OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        reference: "/Users/alice/work/test.log",
      },
    });
    const doc = (await cat.get(r.id))!;
    expect(JSON.stringify(doc.votes)).not.toContain("sk-proj-abc");
    expect(doc.votes![0].evidence!.reference).toBe("~/work/test.log");
  });
});

describe("ongoing maintenance", () => {
  it("keeps newer same-success corrections as reviewable candidates instead of discarding them", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    const incoming = "Start the local Postgres service with brew services start postgresql after checking that its configured port matches";
    const report = await cat.record({ ...lesson, fix: incoming });
    expect(report.action).toBe("merged");
    await cat.maintain();
    const job = cat.maintenanceQueue().find((j) => j.kind === "candidate")!;
    expect(job).toBeDefined();
    await cat.resolveMaintenance({ key: job.key, action: "accept-candidate", evidence });
    const doc = (await cat.get(r.id))!;
    expect(doc.fix).toBe(incoming);
    expect(doc.history!.some((h) => h.input.fix === lesson.fix)).toBe(true);
  });
  it("flags conflicts, supersedes with evidence, retains history and never lets old votes revive obsolete advice", async () => {
    const { cat } = make();
    const a = await cat.record({ ...lesson, claims: [{ key: "hook-output", value: "both" }] });
    const b = await cat.record({ ...lesson, claims: [{ key: "hook-output", value: "nested-only" }] });
    expect(b.action).toBe("linked");
    await cat.maintain();
    const job = cat.maintenanceQueue().find((j) => j.kind === "conflict")!;
    const before = (await cat.recall({ problem: lesson.problem })).hits;
    expect(before.every((h) => h.lifecycle === "disputed")).toBe(true);
    await cat.resolveMaintenance({ key: job.key, action: "supersede", evidence });
    const hits = (await cat.recall({ problem: lesson.problem })).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(job.related_id);
    const old = (await cat.get(job.id))!;
    expect(old.lifecycle).toBe("superseded");
    expect(old.history).toHaveLength(1);
    expect((await cat.recall({ problem: lesson.problem, include_history: true })).hits).toHaveLength(2);
  });
  it("does not treat differing version constraints as contradictory facts", async () => {
    const { cat } = make();
    await cat.record({ ...lesson, applicability: { version: "1" }, claims: [{ key: "api", value: "old" }] });
    await cat.record({ ...lesson, applicability: { version: "2" }, claims: [{ key: "api", value: "new" }] });
    await cat.maintain();
    expect(cat.maintenanceQueue().some((j) => j.kind === "conflict")).toBe(false);
  });
  it("groups reviewed duplicates into one recall slot without deleting either observation", async () => {
    const { cat, store } = make();
    await cat.record(lesson);
    await cat.record({
      ...lesson,
      problem: "Local Postgres database application connection unavailable",
      signals: ["database service inactive"],
    });
    expect(store.count()).toBe(2);
    await cat.maintain();
    const job = cat.maintenanceQueue().find((j) => j.kind === "duplicate")!;
    expect(job).toBeDefined();
    await cat.resolveMaintenance({ key: job.key, action: "consolidate", evidence });
    expect((await cat.recall({ problem: "application local postgres connection", min_score: 0.1 })).hits).toHaveLength(1);
    expect(store.count()).toBe(2);
    const again = await cat.resolveMaintenance({ key: job.key, action: "consolidate", evidence });
    expect(again.duplicate).toBe(true);
  });
  it("rejects stale review proposals after another agent changes the lesson", async () => {
    const { cat } = make();
    const r = await cat.record({ ...lesson, fix: "Installation pending" });
    await cat.maintain();
    const job = cat.maintenanceQueue()[0];
    await cat.amend(r.id, { fix: "Installed and checked" });
    await expect(cat.resolveMaintenance({ key: job.key, action: "dismiss", evidence })).rejects.toThrow(/changed/);
  });
  it("automatically sweeps a bounded batch in the background without running a model or commands", async () => {
    const { cat, store } = make();
    await cat.record({ ...lesson, fix: "Installation pending" });
    const stop = startMaintenanceWorker(cat, store, { intervalMs: 100 });
    try {
      await new Promise((r) => setTimeout(r, 130));
      expect(cat.maintenanceQueue().some((j) => j.kind === "temporary-status")).toBe(true);
    } finally {
      stop();
    }
  });
  it("keeps deferred work across process restarts and makes progress beyond one batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-maint-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const { cat } = make(path);
    for (let i = 0; i < 6; i++)
      await cat.record({
        ...lesson,
        problem: `unresolved ${String.fromCharCode(97 + i)} condition`,
        signals: [],
        fix: "",
        context: [String.fromCharCode(97 + i)],
      });
    const first = await cat.maintain(1);
    expect(first.processed).toBe(1);
    const second = make(path);
    await second.cat.maintain(1);
    expect(second.cat.maintenanceQueue().length).toBeGreaterThan(first.jobs.length);
  });
});

describe("retrieval and persistence", () => {
  it("abstains on a weak generic overlap rather than normalizing the best bad match to certainty", async () => {
    const { cat } = make();
    await cat.record({
      ...lesson,
      problem: "Claude plugin fails because duplicate hooks files are registered",
      signals: ["Duplicate hooks file detected"],
      context: ["claude-code", "plugin"],
      fix: "Remove repeated hooks registration",
    });
    expect(
      (
        await cat.recall({
          problem: "Python pandas merge duplicates rows when lookup table has duplicate keys",
          context: ["python", "pandas"],
        })
      ).hits,
    ).toHaveLength(0);
  });
  it("shares votes atomically between hosts and preserves independent updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-votes-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const a = make(path);
    const b = make(path);
    const r = await a.cat.record(lesson);
    await Promise.all([vote(a.cat, r.id, "a"), vote(b.cat, r.id, "b"), vote(b.cat, r.id, "a")]);
    expect(evidenceSummary((await a.cat.get(r.id))!).successes).toBe(2);
  });
  it("round-trips votes and revisions without inventing verification for legacy records", async () => {
    const a = make();
    const r = await a.cat.record(lesson);
    await a.cat.reinforce(r.id, true);
    await vote(a.cat, r.id, "test");
    await a.cat.amend(r.id, { fix: "Use a different database socket" });
    const text = await a.cat.exportJsonl();
    const b = make();
    await b.cat.importJsonl(text);
    await b.cat.importJsonl(text);
    const doc = (await b.cat.get(r.id))!;
    expect(doc.votes).toHaveLength(1);
    expect(doc.history).toHaveLength(1);
    expect(evidenceSummary(doc).successes).toBe(0);
    const legacy = JSON.parse(text);
    delete legacy.votes;
    delete legacy.history;
    const c = make();
    await c.cat.importJsonl(JSON.stringify(legacy));
    expect(evidenceSummary((await c.cat.get(r.id))!).successes).toBe(0);
  });
  it("merges independent feedback from two exported replicas without last-writer loss", async () => {
    const base = make();
    const r = await base.cat.record(lesson);
    const seed = await base.cat.exportJsonl();
    const a = make(),
      b = make();
    await a.cat.importJsonl(seed);
    await b.cat.importJsonl(seed);
    await vote(a.cat, r.id, "a");
    await vote(b.cat, r.id, "b");
    const exportB = await b.cat.exportJsonl();
    await a.cat.importJsonl(exportB);
    await a.cat.importJsonl(exportB);
    expect(evidenceSummary((await a.cat.get(r.id))!).successes).toBe(2);
  });
});

describe("review and import integrity", () => {
  it("lets a reviewer select either record as the winner instead of depending on random id order", async () => {
    const { cat } = make();
    await cat.record({ ...lesson, claims: [{ key: "field", value: "old" }] });
    await cat.record({ ...lesson, claims: [{ key: "field", value: "new" }] });
    await cat.maintain();
    const job = cat.maintenanceQueue().find((j) => j.kind === "conflict")!;
    await cat.resolveMaintenance({ key: job.key, action: "supersede", winner_id: job.id, evidence });
    expect((await cat.get(job.id))!.lifecycle).not.toBe("superseded");
    expect((await cat.get(job.related_id!))!.superseded_by).toBe(job.id);
  });
  it("a stale active replica cannot revive a superseded record by adding a newer vote", async () => {
    const a = make();
    await a.cat.record({ ...lesson, claims: [{ key: "field", value: "old" }] });
    await a.cat.record({ ...lesson, claims: [{ key: "field", value: "new" }] });
    await a.cat.maintain();
    const job = a.cat.maintenanceQueue().find((j) => j.kind === "conflict")!;
    const stale = await a.cat.exportJsonl();
    await a.cat.resolveMaintenance({ key: job.key, action: "supersede", evidence });
    const lines = stale.split("\n").map((x) => JSON.parse(x));
    const old = lines.find((x) => x.id === job.id);
    old.updated = "2026-09-10T00:00:00Z";
    old.stats.successes = 10;
    old.stats.uses = 10;
    await a.cat.importJsonl(lines.map((x) => JSON.stringify(x)).join("\n"));
    expect((await a.cat.get(job.id))!.lifecycle).toBe("superseded");
    expect((await a.cat.recall({ problem: lesson.problem })).hits.map((h) => h.id)).not.toContain(job.id);
  });
  it("rejects imported verification without evidence rather than crashing recall", async () => {
    const a = make();
    const r = await a.cat.record(lesson);
    await vote(a.cat, r.id, "one");
    const doc = JSON.parse(await a.cat.exportJsonl());
    delete doc.votes[0].evidence;
    const b = make();
    const result = await b.cat.importJsonl(JSON.stringify(doc));
    expect(result.errors).toHaveLength(1);
    expect(b.store.count()).toBe(0);
  });
  it("different imported content becomes a review candidate without overwriting the active recommendation", async () => {
    const a = make();
    const r = await a.cat.record(lesson);
    const seed = await a.cat.exportJsonl();
    const b = make();
    await b.cat.importJsonl(seed);
    await b.cat.amend(r.id, { fix: "A competing unverified correction" });
    const update = await b.cat.exportJsonl();
    await a.cat.importJsonl(update);
    await a.cat.importJsonl(update);
    expect((await a.cat.get(r.id))!.fix).toBe(lesson.fix);
    await a.cat.maintain();
    expect(a.cat.maintenanceQueue().some((j) => j.kind === "candidate")).toBe(true);
  });
  it("unchanged repeated reports do not grow redundant history indefinitely", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    await cat.record(lesson);
    const count = (await cat.get(r.id))!.history!.length;
    for (let i = 0; i < 10; i++) await cat.record(lesson);
    expect((await cat.get(r.id))!.history!.length).toBe(count);
  });
});

describe("scope preservation", () => {
  it("does not discard new preconditions or claims while merging a similar fix", async () => {
    const { cat, store } = make();
    await cat.record(lesson);
    const scoped = await cat.record({ ...lesson, preconditions: ["Database service has been confirmed stopped"] });
    expect(scoped.action).toBe("linked");
    expect(store.count()).toBe(2);
  });
  it("restoring an earlier unscoped revision actually removes later scope and claims", async () => {
    const { cat } = make();
    const r = await cat.record(lesson);
    const old = revisionOf((await cat.get(r.id))!);
    const next = await cat.amend(r.id, { applicability: { version: "17" }, claims: [{ key: "new", value: "constraint" }] });
    const restored = await cat.restore(r.id, old, revisionOf(next), "Undo the accidental restriction");
    expect(restored.applicability).toBeUndefined();
    expect(restored.claims).toBeUndefined();
    expect(revisionOf(restored)).toBe(old);
  });
  it("a queued candidate cannot reactivate a superseded lesson", async () => {
    const { cat } = make();
    const a = await cat.record(lesson);
    await cat.record({ ...lesson, fix: lesson.fix + " after checking the service status" });
    const b = await cat.record({ ...lesson, fix: "Configure an explicit database socket path" });
    await cat.maintain();
    const candidate = cat.maintenanceQueue(100).find((j) => j.kind === "candidate")!;
    // Simulate a completed reviewed supersession before the stale candidate review arrives.
    const doc = (await cat.get(a.id))!;
    const exported = JSON.parse((await cat.exportJsonl()).split("\n").find((s) => JSON.parse(s).id === a.id)!);
    exported.lifecycle = "superseded";
    exported.superseded_by = b.id;
    exported.updated = "2026-09-10T00:00:00Z";
    await cat.importJsonl(JSON.stringify(exported));
    await expect(cat.resolveMaintenance({ key: candidate.key, action: "accept-candidate", evidence })).rejects.toThrow(/no longer active/);
  });
});
