/**
 * Durable storage: one SQLite file via Node's built-in `node:sqlite`.
 * No native build step, so the server installs cleanly anywhere Node >= 22.13 runs.
 * The whole record lives in a JSON column; a few columns are lifted out for lookups.
 * Embeddings are stored alongside so restarts never re-run the model.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Experience } from "./schema.js";

export interface StoredRow {
  doc: Experience;
  embedding: Float32Array | null;
  embedModel: string | null;
}

export interface RecallEvent {
  at: string;
  origin: "hook" | "mcp" | "cli";
  event?: string;
  /** Hash of the host session id. */
  session?: string;
  /** Hash of the tool call that failed, so a later success of the same call can be recognised. */
  action?: string;
  /** Hash of the query. */
  query: string;
  project?: string;
  hits: Array<{ id: string; score: number }>;
}

export class Store {
  private readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS experiences (
        id          TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        kind        TEXT NOT NULL,
        doc         TEXT NOT NULL,
        embedding   BLOB,
        embed_model TEXT,
        created     TEXT NOT NULL,
        updated     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_experiences_fingerprint ON experiences(fingerprint);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance (
        key TEXT PRIMARY KEY, doc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recall_events (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        at        TEXT NOT NULL,
        origin    TEXT NOT NULL,
        event     TEXT,
        session   TEXT,
        action    TEXT,
        query     TEXT NOT NULL,
        project   TEXT,
        hits      TEXT NOT NULL,
        helped_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_recall_events_at ON recall_events(at);
      CREATE INDEX IF NOT EXISTS idx_recall_events_action ON recall_events(session, action);
      CREATE TABLE IF NOT EXISTS recall_last (id TEXT PRIMARY KEY, at TEXT NOT NULL, shown INTEGER NOT NULL);
    `);
    this.setMeta("schema_version", "1");
  }

  /** Changes whenever any connection (including another process) commits. Cheap to poll. */
  dataVersion(): number {
    const row = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    return row.data_version;
  }

  all(): StoredRow[] {
    const rows = this.db.prepare("SELECT doc, embedding, embed_model FROM experiences ORDER BY id").all() as Array<{
      doc: string;
      embedding: Uint8Array | null;
      embed_model: string | null;
    }>;
    return rows.map((r) => ({
      doc: Experience.parse(JSON.parse(r.doc)),
      embedding: r.embedding ? toFloat32(r.embedding) : null,
      embedModel: r.embed_model,
    }));
  }

  get(id: string): StoredRow | null {
    const r = this.db.prepare("SELECT doc, embedding, embed_model FROM experiences WHERE id = ?").get(id) as
      { doc: string; embedding: Uint8Array | null; embed_model: string | null } | undefined;
    if (!r) return null;
    return {
      doc: Experience.parse(JSON.parse(r.doc)),
      embedding: r.embedding ? toFloat32(r.embedding) : null,
      embedModel: r.embed_model,
    };
  }

  upsert(doc: Experience, embedding: Float32Array | null, embedModel: string | null): void {
    this.db
      .prepare(
        `INSERT INTO experiences (id, fingerprint, kind, doc, embedding, embed_model, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           kind        = excluded.kind,
           doc         = excluded.doc,
           embedding   = excluded.embedding,
           embed_model = excluded.embed_model,
           updated     = excluded.updated`,
      )
      .run(
        doc.id,
        doc.fingerprint,
        doc.kind,
        JSON.stringify(doc),
        embedding ? toBuffer(embedding) : null,
        embedModel,
        doc.created,
        doc.updated,
      );
  }

  /** Read/check/write under the SQLite writer lock, shared by every host process. */
  update(id: string, change: (current: Experience) => Experience): Experience {
    return this.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error(`no experience with id ${id}`);
      const next = change(current.doc);
      this.upsert(next, current.embedding, current.embedModel);
      return next;
    });
  }

  replace(expected: Experience, next: Experience, embedding: Float32Array | null, model: string | null): void {
    this.transaction(() => {
      if (JSON.stringify(this.get(expected.id)?.doc) !== JSON.stringify(Experience.parse(expected)))
        throw new Error("experience changed concurrently; reread and retry");
      this.upsert(next, embedding, model);
    });
  }

  putJob(key: string, doc: unknown): void {
    this.db.prepare("INSERT INTO maintenance(key,doc) VALUES (?,?) ON CONFLICT(key) DO NOTHING").run(key, JSON.stringify(doc));
  }
  jobs<T>(): T[] {
    return (this.db.prepare("SELECT doc FROM maintenance ORDER BY key").all() as { doc: string }[]).map((r) => JSON.parse(r.doc));
  }
  finishJob(key: string): void {
    this.db.prepare("DELETE FROM maintenance WHERE key=?").run(key);
  }

  setEmbedding(id: string, embedding: Float32Array, embedModel: string): void {
    this.db.prepare("UPDATE experiences SET embedding = ?, embed_model = ? WHERE id = ?").run(toBuffer(embedding), embedModel, id);
  }

  delete(id: string): boolean {
    const res = this.db.prepare("DELETE FROM experiences WHERE id = ?").run(id);
    return res.changes > 0;
  }

  count(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM experiences").get() as { n: number };
    return r.n;
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Atomic across hook processes; only hashes are stored, never prompts or transcript content. */
  claimHookReminder(key: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(`hook-reminder:${key}`, "sent").changes > 0;
  }

  // -------------------------------------------------------------- usage log

  /**
   * One row per recall that reached a host. Only hashes, ids and scores are stored: never prompt,
   * error or transcript text. `recall_last` keeps a per-lesson last-shown time for archiving.
   */
  logRecall(event: RecallEvent): number {
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('recall-log:since', ?)").run(event.at);
      const res = this.db
        .prepare("INSERT INTO recall_events (at, origin, event, session, action, query, project, hits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(event.at, event.origin, event.event ?? null, event.session ?? null, event.action ?? null, event.query, event.project ?? null, JSON.stringify(event.hits));
      const touch = this.db.prepare(
        "INSERT INTO recall_last (id, at, shown) VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET at = excluded.at, shown = shown + 1",
      );
      for (const h of event.hits) touch.run(h.id, event.at);
      // Bounded: a year of history is plenty for usage statistics.
      this.db.prepare("DELETE FROM recall_events WHERE at < ?").run(new Date(Date.parse(event.at) - 365 * 86400000).toISOString());
      return Number(res.lastInsertRowid);
    });
  }

  /** The latest unresolved event in this session where lessons were shown for this action. */
  shownFor(session: string, action: string, since: string): { seq: number; ids: string[] } | null {
    const r = this.db
      .prepare(
        "SELECT seq, hits FROM recall_events WHERE session = ? AND action = ? AND at >= ? AND helped_at IS NULL AND hits != '[]' ORDER BY seq DESC LIMIT 1",
      )
      .get(session, action, since) as { seq: number; hits: string } | undefined;
    if (!r) return null;
    return { seq: r.seq, ids: (JSON.parse(r.hits) as RecallEvent["hits"]).map((h) => h.id) };
  }

  /** Atomic: true only for the first caller, so concurrent hook processes report once. */
  markHelped(seq: number, at: string): boolean {
    return this.db.prepare("UPDATE recall_events SET helped_at = ? WHERE seq = ? AND helped_at IS NULL").run(at, seq).changes > 0;
  }

  recallEvents(since: string): Array<{ at: string; origin: string; hits: RecallEvent["hits"]; helped: boolean }> {
    const rows = this.db.prepare("SELECT at, origin, hits, helped_at FROM recall_events WHERE at >= ? ORDER BY seq").all(since) as Array<{
      at: string;
      origin: string;
      hits: string;
      helped_at: string | null;
    }>;
    return rows.map((r) => ({ at: r.at, origin: r.origin, hits: JSON.parse(r.hits), helped: r.helped_at !== null }));
  }

  lastShown(): Map<string, { at: string; shown: number }> {
    const rows = this.db.prepare("SELECT id, at, shown FROM recall_last").all() as Array<{ id: string; at: string; shown: number }>;
    return new Map(rows.map((r) => [r.id, { at: r.at, shown: r.shown }]));
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}

function toBuffer(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function toFloat32(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
