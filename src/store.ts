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
    `);
    this.setMeta("schema_version", "1");
  }

  /** Changes whenever any connection (including another process) commits. Cheap to poll. */
  dataVersion(): number {
    const row = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    return row.data_version;
  }

  all(): StoredRow[] {
    const rows = this.db
      .prepare("SELECT doc, embedding, embed_model FROM experiences ORDER BY id")
      .all() as Array<{ doc: string; embedding: Uint8Array | null; embed_model: string | null }>;
    return rows.map((r) => ({
      doc: Experience.parse(JSON.parse(r.doc)),
      embedding: r.embedding ? toFloat32(r.embedding) : null,
      embedModel: r.embed_model,
    }));
  }

  get(id: string): StoredRow | null {
    const r = this.db.prepare("SELECT doc, embedding, embed_model FROM experiences WHERE id = ?").get(id) as
      | { doc: string; embedding: Uint8Array | null; embed_model: string | null }
      | undefined;
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
           updated     = excluded.updated`
      )
      .run(
        doc.id,
        doc.fingerprint,
        doc.kind,
        JSON.stringify(doc),
        embedding ? toBuffer(embedding) : null,
        embedModel,
        doc.created,
        doc.updated
      );
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
    return this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(`hook-reminder:${key}`, "sent").changes > 0;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
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
