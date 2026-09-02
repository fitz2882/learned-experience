import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue.js";
import { Store } from "../src/store.js";
import { FakeEmbedder } from "./fake-embedder.js";

let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 1, 12, 0, tick++));

function make(withEmbedder = true) {
  const store = new Store(":memory:");
  const embedder = withEmbedder ? new FakeEmbedder() : null;
  const cat = new Catalogue(store, embedder, { now });
  return { store, cat, embedder };
}

const pgDown = {
  problem: "App cannot connect to local Postgres",
  signals: ["Error: connect ECONNREFUSED 127.0.0.1:5432"],
  context: ["node", "postgres", "macos"],
  attempts: [
    { action: "restart app", result: "failed" as const },
    { action: "brew services start postgresql@16", result: "worked" as const },
  ],
  fix: "Start the Postgres service: brew services start postgresql@16",
  avoid: ["Restarting the app does nothing; the DB is not running"],
  root_cause: "Postgres service was not running after reboot",
  outcome: "success" as const,
  kind: "episode" as const,
};

describe("record + recall", () => {
  it("creates a record, then recalls it by exact fingerprint", async () => {
    const { cat } = make();
    const r = await cat.record(pgDown);
    expect(r.action).toBe("created");
    // Different wording, different port, only one context tag, one identical error string.
    const res = await cat.recall({ problem: "database refusing connections", signals: ["Error: connect ECONNREFUSED 127.0.0.1:5433"], context: ["postgres"] });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe(r.id);
    expect(res.hits[0].match.exact).toBe(true);
    expect(res.hits[0].match.via).toContain("fingerprint");
    expect(res.hits[0].match.score).toBeGreaterThan(0.8);
    expect(res.hits[0].fix).toContain("brew services");
  });

  it("recalls similar problems without exact signals via lexical + semantic", async () => {
    const { cat } = make();
    await cat.record(pgDown);
    await cat.record({ ...pgDown, problem: "Vite dev server HMR not reloading", signals: ["hmr update failed"], context: ["vite", "react"], fix: "Set server.watch.usePolling", root_cause: undefined });
    const res = await cat.recall({ problem: "cannot connect to postgres database", context: ["postgres"] });
    expect(res.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.hits[0].problem).toContain("Postgres");
    expect(res.hits[0].match.exact).toBe(false);
    expect(res.hits[0].match.via).toEqual(expect.arrayContaining(["lexical", "semantic"]));
    expect(res.semantic).toBe(true);
  });

  it("works lexically with no embedder at all", async () => {
    const { cat } = make(false);
    await cat.record(pgDown);
    const res = await cat.recall({ problem: "postgres connection refused" });
    expect(res.semantic).toBe(false);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].match.via).toEqual(["lexical"]);
  });

  it("returns nothing for unrelated problems", async () => {
    const { cat } = make();
    await cat.record(pgDown);
    const res = await cat.recall({ problem: "Swift compiler segfault on generic protocol", context: ["swift", "xcode"] });
    expect(res.hits).toHaveLength(0);
  });

  it("redacts secrets and home paths on write", async () => {
    const { cat } = make();
    const r = await cat.record({
      ...pgDown,
      signals: ["connect failed for postgres://admin:s3cretpass@localhost/db from /Users/dave/app"],
      fix: "export DATABASE_URL=postgres://<CREDS>@localhost/db and set OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    });
    const doc = (await cat.get(r.id))!;
    expect(doc.signals[0]).toBe("connect failed for postgres://<CREDS>@localhost/db from ~/app");
    expect(doc.fix).not.toContain("sk-proj-abc");
    expect(doc.fix).toContain("OPENAI_API_KEY=<SECRET>");
  });
});

describe("never learn the same thing twice", () => {
  it("merges a second report with the same fingerprint and compatible fix", async () => {
    const { cat, store } = make();
    const a = await cat.record(pgDown);
    const b = await cat.record({
      ...pgDown,
      problem: "Postgres refuses connections after reboot",
      signals: ["Error: connect ECONNREFUSED 127.0.0.1:5432"],
      context: ["postgres"],
      avoid: ["Do not reinstall postgres"],
      fix: "Run brew services start postgresql@16",
    });
    expect(b.action).toBe("merged");
    expect(b.merged_into).toBe(a.id);
    expect(store.count()).toBe(1);
    const doc = (await cat.get(a.id))!;
    expect(doc.stats.merged).toBe(1);
    expect(doc.avoid).toEqual(expect.arrayContaining(["Do not reinstall postgres", pgDown.avoid[0]]));
  });

  it("links instead of merging when the same symptom has a different fix", async () => {
    const { cat, store } = make();
    const a = await cat.record(pgDown);
    const b = await cat.record({
      ...pgDown,
      fix: "Change PGPORT in .env to 5433 because docker maps postgres to a different port",
      avoid: [],
      root_cause: "Wrong port in env",
    });
    expect(b.action).toBe("linked");
    expect(b.related).toEqual([a.id]);
    expect(store.count()).toBe(2);
    expect((await cat.get(a.id))!.related).toEqual([b.id]);
  });

  it("merges semantic near-duplicates even when signals differ slightly", async () => {
    const { cat, store } = make();
    const a = await cat.record({ ...pgDown, signals: [] });
    const b = await cat.record({ ...pgDown, signals: [], problem: "App cannot connect to local Postgres server" });
    expect(b.action).toBe("merged");
    expect(b.merged_into).toBe(a.id);
    expect(store.count()).toBe(1);
  });

  it("keeps fingerprint and signal indexes consistent after a merge changes identity fields", async () => {
    const { cat, store } = make();
    const a = await cat.record({ ...pgDown, signals: [], context: ["postgres"] });
    // Same problem statement, new context tag and a new signal: merges, and the merged identity must be indexed.
    const b = await cat.record({ ...pgDown, signals: ["Error: connect ECONNREFUSED 127.0.0.1:5432"], context: ["postgres", "docker"] });
    expect(b.action).toBe("merged");
    const doc = (await cat.get(a.id))!;
    expect(doc.context).toEqual(["docker", "postgres"]);
    expect(doc.signals).toHaveLength(1);
    // A third identical report must dedup deterministically against the merged record.
    const c = await cat.record({ ...pgDown, signals: [], context: ["postgres", "docker"] });
    expect(c.action).toBe("merged");
    expect(c.merged_into).toBe(a.id);
    expect(store.count()).toBe(1);
    // The merged record is findable under its recomputed fingerprint.
    const byFp = await cat.recall({ problem: pgDown.problem, signals: ["Error: connect ECONNREFUSED 127.0.0.1:5432"], context: ["docker", "postgres"] });
    expect(byFp.hits[0]?.match.exact).toBe(true);
    const exact = await cat.recall({ problem: "db", signals: ["Error: connect ECONNREFUSED 10.0.0.1:5432"], context: ["docker"] });
    expect(exact.hits[0]?.match.exact).toBe(true);
  });

  it("does not leave orphaned signal keys when the signal cap truncates a merge", async () => {
    const { cat } = make();
    const eight = Array.from({ length: 8 }, (_, i) => `signal number ${String.fromCharCode(98 + i)}`); // b..i
    const a = await cat.record({ ...pgDown, signals: eight });
    const b = await cat.record({ ...pgDown, signals: ["signal number a", ...eight.slice(0, 2)] });
    expect(b.action).toBe("merged");
    const doc = (await cat.get(a.id))!;
    expect(doc.signals).toHaveLength(8);
    expect(doc.signals).toEqual(eight); // existing signals win; the new one was dropped
    const dropped = await cat.recall({ problem: "x", signals: ["signal number a"] });
    expect(dropped.hits.some((h) => h.match.exact)).toBe(false);
  });

  it("a failed report followed by a successful one upgrades the fix", async () => {
    const { cat } = make();
    const a = await cat.record({ ...pgDown, fix: "", outcome: "failure", avoid: ["tried restarting"] });
    const b = await cat.record(pgDown);
    expect(b.action).toBe("merged");
    const doc = (await cat.get(a.id))!;
    expect(doc.outcome).toBe("success");
    expect(doc.fix).toContain("brew services");
    expect(doc.avoid).toContain("tried restarting");
  });
});

describe("reinforce (learning loop)", () => {
  it("raises confidence on success and lowers it on failure, and ranks accordingly", async () => {
    const { cat } = make();
    const good = await cat.record(pgDown);
    const bad = await cat.record({ ...pgDown, fix: "Reinstall Postgres from scratch", avoid: [] });
    expect(bad.action).toBe("linked");
    await cat.reinforce(good.id, true);
    await cat.reinforce(good.id, true);
    await cat.reinforce(bad.id, false, "reinstall wiped data and did not help");
    const g = (await cat.get(good.id))!;
    const b = (await cat.get(bad.id))!;
    expect(g.stats).toMatchObject({ uses: 2, successes: 2, failures: 0 });
    expect(b.stats).toMatchObject({ uses: 1, successes: 0, failures: 1 });
    expect(b.avoid).toContain("reinstall wiped data and did not help");
    const res = await cat.recall({ problem: "db down", signals: pgDown.signals, context: pgDown.context });
    expect(res.hits.map((h) => h.id)).toEqual([good.id, bad.id]);
    expect(res.hits[0].confidence).toBeCloseTo(0.75);
    expect(res.hits[1].confidence).toBeCloseTo(1 / 3);
  });

  it("rejects unknown ids", async () => {
    const { cat } = make();
    await expect(cat.reinforce("x_nope", true)).rejects.toThrow(/no experience/);
  });
});

describe("amend / forget / stats", () => {
  it("amend patches fields and re-fingerprints", async () => {
    const { cat } = make();
    const r = await cat.record(pgDown);
    const before = (await cat.get(r.id))!.fingerprint;
    const doc = await cat.amend(r.id, { signals: ["ECONNREFUSED ::1:5432"], fix: "Start postgres via brew services" });
    expect(doc.fingerprint).not.toBe(before);
    expect(doc.fix).toBe("Start postgres via brew services");
    const res = await cat.recall({ problem: "db", signals: ["ECONNREFUSED ::1:5432"], context: pgDown.context });
    expect(res.hits[0]?.match.exact).toBe(true);
  });

  it("forget removes from store and indexes", async () => {
    const { cat, store } = make();
    const r = await cat.record(pgDown);
    expect(await cat.forget(r.id)).toBe(true);
    expect(await cat.forget(r.id)).toBe(false);
    expect(store.count()).toBe(0);
    expect((await cat.recall({ problem: "postgres connection refused" })).hits).toHaveLength(0);
  });

  it("stats summarise the catalogue", async () => {
    const { cat } = make();
    const r = await cat.record(pgDown);
    await cat.record(pgDown);
    await cat.reinforce(r.id, true);
    const s = await cat.stats();
    expect(s).toMatchObject({ records: 1, duplicates_prevented: 1, total_uses: 1, success_rate: 1, embedded: 1, embedding_model: "fake:hashed-bow-64" });
  });
});

describe("consolidate", () => {
  it("clusters similar episodes deterministically", async () => {
    const { cat } = make();
    const base = { ...pgDown, signals: [] as string[], attempts: [] };
    await cat.record({ ...base, problem: "App cannot connect to local Postgres on port 5432" });
    await cat.record({ ...base, problem: "Service cannot connect to Postgres database locally" });
    await cat.record({ ...base, problem: "Local Postgres connection refused for the app" });
    await cat.record({ ...base, problem: "Xcode build fails on missing provisioning profile", context: ["xcode", "ios"] });
    const clusters = await cat.consolidate(0.5, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
    expect(clusters[0].shared_context).toEqual(["macos", "node", "postgres"]);
  });
});

describe("portability", () => {
  it("round-trips through JSONL, merging duplicates and preferring newer records", async () => {
    const src = make();
    const a = await src.cat.record(pgDown);
    await src.cat.reinforce(a.id, true);
    const jsonl = await src.cat.exportJsonl();
    expect(jsonl.split("\n")).toHaveLength(1);

    const dst = make(false); // different (no) embedding model at destination
    const first = await dst.cat.importJsonl(jsonl);
    expect(first).toMatchObject({ inserted: 1, updated: 0, merged: 0, skipped: 0 });
    const again = await dst.cat.importJsonl(jsonl);
    expect(again).toMatchObject({ inserted: 0, skipped: 1 });

    // Same lesson recorded independently on the destination gets merged with the import.
    const other = make();
    await other.cat.record({ ...pgDown, fix: "brew services start postgresql@16" });
    const merged = await other.cat.importJsonl(jsonl);
    expect(merged).toMatchObject({ merged: 1 });
    expect(other.store.count()).toBe(1);
    const doc = (await other.cat.get((await other.cat.recall({ problem: "x", signals: pgDown.signals, context: pgDown.context })).hits[0].id))!;
    expect(doc.stats.uses).toBe(1);

    const bad = await dst.cat.importJsonl('{"not":"a record"}\n');
    expect(bad.errors).toHaveLength(1);
  });

  it("re-importing the same file never double-counts stats", async () => {
    const src = make();
    const a = await src.cat.record(pgDown);
    await src.cat.reinforce(a.id, true);
    await src.cat.reinforce(a.id, true);
    const jsonl = await src.cat.exportJsonl();

    const dst = make();
    const local = await dst.cat.record({ ...pgDown, fix: "brew services start postgresql@16" });
    await dst.cat.reinforce(local.id, false);
    expect(await dst.cat.importJsonl(jsonl)).toMatchObject({ merged: 1 });
    expect(await dst.cat.importJsonl(jsonl)).toMatchObject({ merged: 0, skipped: 1 });
    expect(await dst.cat.importJsonl(jsonl)).toMatchObject({ merged: 0, skipped: 1 });
    const doc = (await dst.cat.get(local.id))!;
    expect(doc.stats).toMatchObject({ uses: 3, successes: 2, failures: 1, merged: 1 });
    expect(dst.store.count()).toBe(1);
  });

  it("import merges by the same rules as record (identical signal, different fingerprint)", async () => {
    const src = make();
    await src.cat.record({ ...pgDown, context: ["postgres", "linux"] }); // different context => different fingerprint
    const jsonl = await src.cat.exportJsonl();
    const dst = make();
    await dst.cat.record(pgDown);
    expect(await dst.cat.importJsonl(jsonl)).toMatchObject({ merged: 1, inserted: 0 });
    expect(dst.store.count()).toBe(1);
    const hit = (await dst.cat.recall({ problem: "x", signals: pgDown.signals })).hits[0];
    expect(hit.context).toEqual(["linux", "macos", "node", "postgres"]);
  });

  it("persists to disk and reloads with stored embeddings", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "exp-"));
    const path = join(dir, "e.db");
    const s1 = new Store(path);
    const e1 = new FakeEmbedder();
    const c1 = new Catalogue(s1, e1, { now });
    const r = await c1.record(pgDown);
    s1.close();

    const s2 = new Store(path);
    const e2 = new FakeEmbedder();
    const c2 = new Catalogue(s2, e2, { now });
    await c2.init();
    expect(e2.calls).toBe(0); // embeddings came from disk
    const res = await c2.recall({ problem: "db", signals: pgDown.signals, context: pgDown.context });
    expect(res.hits[0].id).toBe(r.id);
    s2.close();
  });

  it("sees writes made by another process on the same file", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "exp-")), "e.db");
    const a = new Catalogue(new Store(path), null, { now });
    const b = new Catalogue(new Store(path), null, { now });
    await a.init();
    await b.init();
    await a.record(pgDown);
    const res = await b.recall({ problem: "postgres connection refused" });
    expect(res.hits).toHaveLength(1);
  });
});
