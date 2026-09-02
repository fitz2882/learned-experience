/**
 * The Catalogue is the domain service behind every tool. It owns:
 *   - the deterministic fingerprint layer (exact recall, dedup on write)
 *   - the hybrid similarity layer (dense + BM25, fused deterministically)
 *   - the learning loop (reinforce -> confidence -> ranking)
 *   - portability (JSONL export/import)
 *
 * Nothing here calls an LLM. The only non-deterministic component is the embedding model,
 * and it is pinned by id so the same model always yields the same vectors.
 */
import { randomBytes } from "node:crypto";
import type { Embedder } from "./embed/index.js";
import { Bm25Index } from "./index/bm25.js";
import { VectorIndex } from "./index/vector.js";
import { clean, fingerprint, jaccard, normalizeTag, problemKey, signalKeys, tokenize, uniqueSorted } from "./normalize.js";
import {
  Experience,
  ExperienceInput,
  Kind,
  RecallHit,
  SCHEMA_VERSION,
  confidence,
  relevance,
  round,
  toRecallHit,
} from "./schema.js";
import { Store } from "./store.js";

export interface CatalogueOptions {
  /** Weight of dense similarity vs lexical when both exist. */
  denseWeight?: number;
  /** Cosine similarity at or above which two problems are treated as the same. */
  duplicateCosine?: number;
  /** Token Jaccard of problem statements required alongside cosine for a duplicate. */
  duplicateJaccard?: number;
  /** Token Jaccard of two fixes at or above which they count as "the same fix". */
  sameFixJaccard?: number;
  now?: () => Date;
}

export interface RecallQuery {
  problem: string;
  signals?: string[];
  context?: string[];
  limit?: number;
  min_score?: number;
  kinds?: Kind[];
}

export interface RecallResult {
  hits: RecallHit[];
  searched: number;
  semantic: boolean;
}

export interface RecordResult {
  id: string;
  action: "created" | "merged" | "linked";
  /** Present when merged: the record the report was folded into. */
  merged_into?: string;
  /** Present when linked: records with the same fingerprint but a different fix. */
  related?: string[];
  fingerprint: string;
}

export interface Cluster {
  ids: string[];
  problems: string[];
  shared_context: string[];
  size: number;
}

const MERGE_ORDER: Record<string, number> = { failure: 0, partial: 1, success: 2 };

export class Catalogue {
  private readonly records = new Map<string, Experience>();
  private readonly byFingerprint = new Map<string, Set<string>>();
  private readonly bySignal = new Map<string, Set<string>>();
  private readonly byProblem = new Map<string, Set<string>>();
  private readonly lexical = new Bm25Index();
  private readonly vectors = new VectorIndex();
  private readonly opts: Required<CatalogueOptions>;
  private ready: Promise<void> | null = null;
  private lastDataVersion = -1;
  private embedFailure: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly embedder: Embedder | null,
    opts: CatalogueOptions = {}
  ) {
    this.opts = {
      denseWeight: opts.denseWeight ?? 0.6,
      duplicateCosine: opts.duplicateCosine ?? 0.92,
      duplicateJaccard: opts.duplicateJaccard ?? 0.5,
      sameFixJaccard: opts.sameFixJaccard ?? 0.4,
      now: opts.now ?? (() => new Date()),
    };
  }

  get embedderId(): string | null {
    return this.embedder?.id ?? null;
  }

  /** Load from disk (and re-embed anything the current model has not seen). Idempotent. */
  init(): Promise<void> {
    if (!this.ready) this.ready = this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    this.records.clear();
    this.byFingerprint.clear();
    this.bySignal.clear();
    this.byProblem.clear();
    const rows = this.store.all();
    const toEmbed: Experience[] = [];
    // Rebuild in-memory indexes from scratch.
    for (const id of [...this.allIndexedIds()]) {
      this.lexical.remove(id);
      this.vectors.remove(id);
    }
    for (const row of rows) {
      this.indexRecord(row.doc);
      if (row.embedding && row.embedModel === this.embedderId) this.vectors.add(row.doc.id, row.embedding);
      else if (this.embedder) toEmbed.push(row.doc);
    }
    if (this.embedder && toEmbed.length > 0) {
      try {
        for (let i = 0; i < toEmbed.length; i += 32) {
          const batch = toEmbed.slice(i, i + 32);
          const vecs = await this.embedder.embed(batch.map(embedText));
          batch.forEach((doc, j) => {
            this.vectors.add(doc.id, vecs[j]);
            this.store.setEmbedding(doc.id, vecs[j], this.embedder!.id);
          });
        }
        this.embedFailure = null;
      } catch (e) {
        // Lexical recall keeps working; semantic recall degrades gracefully.
        this.embedFailure = e instanceof Error ? e.message : String(e);
      }
    }
    this.lastDataVersion = this.store.dataVersion();
  }

  private allIndexedIds(): Iterable<string> {
    return this.records.keys();
  }

  /** Another process may have written to the same file. Reload if so. */
  private async sync(): Promise<void> {
    await this.init();
    if (this.store.dataVersion() !== this.lastDataVersion) await this.load();
  }

  private indexRecord(doc: Experience): void {
    this.records.set(doc.id, doc);
    let set = this.byFingerprint.get(doc.fingerprint);
    if (!set) this.byFingerprint.set(doc.fingerprint, (set = new Set()));
    set.add(doc.id);
    for (const key of signalKeys(doc.signals)) {
      let s = this.bySignal.get(key);
      if (!s) this.bySignal.set(key, (s = new Set()));
      s.add(doc.id);
    }
    const pk = problemKey(doc.problem);
    let p = this.byProblem.get(pk);
    if (!p) this.byProblem.set(pk, (p = new Set()));
    p.add(doc.id);
    this.lexical.add(doc.id, lexicalText(doc));
  }

  private unindexRecord(doc: Experience): void {
    this.records.delete(doc.id);
    this.byFingerprint.get(doc.fingerprint)?.delete(doc.id);
    for (const key of signalKeys(doc.signals)) this.bySignal.get(key)?.delete(doc.id);
    this.byProblem.get(problemKey(doc.problem))?.delete(doc.id);
    this.lexical.remove(doc.id);
    this.vectors.remove(doc.id);
  }

  private async embedOne(text: string): Promise<Float32Array | null> {
    if (!this.embedder) return null;
    try {
      const [v] = await this.embedder.embed([text]);
      this.embedFailure = null;
      return v ?? null;
    } catch (e) {
      this.embedFailure = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  private persist(doc: Experience, vec: Float32Array | null): void {
    this.indexRecord(doc);
    if (vec) this.vectors.add(doc.id, vec);
    this.store.upsert(doc, vec, vec ? this.embedderId : null);
    this.lastDataVersion = this.store.dataVersion();
  }

  // ------------------------------------------------------------------ recall

  async recall(q: RecallQuery): Promise<RecallResult> {
    await this.sync();
    const limit = Math.max(1, Math.min(q.limit ?? 5, 25));
    const minScore = q.min_score ?? 0.35;
    const signals = (q.signals ?? []).map((s) => clean(s, 300));
    const context = (q.context ?? []).map(normalizeTag).filter(Boolean);
    const problem = clean(q.problem, 240);
    const fp = fingerprint(problem, signals, context);
    const kinds = new Set(q.kinds ?? ["episode", "rule"]);

    const scores = new Map<string, { score: number; via: Set<RecallHit["match"]["via"][number]> }>();
    const bump = (id: string, s: number, via: RecallHit["match"]["via"][number]) => {
      const cur = scores.get(id) ?? { score: 0, via: new Set() };
      cur.score += s;
      cur.via.add(via);
      scores.set(id, cur);
    };

    // 1. Deterministic exact layer: whole-problem fingerprint, or any identical error signal
    //    in a compatible context (no context given, record has none, or they overlap).
    for (const id of this.byFingerprint.get(fp) ?? []) bump(id, 1, "fingerprint");
    for (const id of this.exactSignalMatches(signals, context)) bump(id, 1, "fingerprint");

    // 2. Lexical layer (BM25, normalised to the best hit for this query).
    const lexHits = this.lexical.search(lexicalQuery(problem, signals, context), 50);
    const lexMax = lexHits[0]?.score ?? 0;
    let denseHits: Array<{ id: string; score: number }> = [];

    // 3. Dense layer.
    const qv = await this.embedOne(embedText({ problem, signals, context }));
    if (qv) denseHits = this.vectors.search(qv, 50);
    const wD = qv ? this.opts.denseWeight : 0;
    const wL = qv ? 1 - this.opts.denseWeight : 1;

    for (const h of lexHits) if (lexMax > 0) bump(h.id, wL * (h.score / lexMax), "lexical");
    for (const h of denseHits) if (h.score > 0) bump(h.id, wD * h.score, "semantic");

    const queryKeys = new Set(queryKeysFor(problem, signals));
    const hits: RecallHit[] = [];
    for (const [id, { score, via }] of scores) {
      const doc = this.records.get(id);
      if (!doc || !kinds.has(doc.kind)) continue;
      if (doc.dismissed_for.some((k) => queryKeys.has(k))) continue; // known false positive for this query
      const exact = via.has("fingerprint");
      const base = exact ? 1 : Math.min(score, 1) * relevance(doc.stats);
      const final = base * (0.7 + 0.3 * confidence(doc.stats));
      if (!exact && final < minScore) continue;
      hits.push(toRecallHit(doc, { score: final, exact, via: [...via].sort() }));
    }
    hits.sort((a, b) => b.match.score - a.match.score || (a.id < b.id ? -1 : 1));
    return { hits: hits.slice(0, limit), searched: this.records.size, semantic: qv !== null };
  }

  private exactSignalMatches(signals: string[], context: string[]): Set<string> {
    const out = new Set<string>();
    for (const key of signalKeys(signals)) {
      for (const id of this.bySignal.get(key) ?? []) {
        const doc = this.records.get(id);
        if (!doc) continue;
        const compatible = context.length === 0 || doc.context.length === 0 || doc.context.some((c) => context.includes(c));
        if (compatible) out.add(id);
      }
    }
    return out;
  }

  /**
   * Records that might be "the same lesson" as the input, in deterministic id order:
   * same whole-problem fingerprint, any identical signal in a compatible context,
   * the identical problem statement, or a semantic near-duplicate (cosine and problem-token Jaccard both high).
   */
  private duplicateCandidates(input: ExperienceInput, fp: string, vec: Float32Array | null): string[] {
    const candidates = new Set<string>([
      ...(this.byFingerprint.get(fp) ?? []),
      ...this.exactSignalMatches(input.signals, input.context),
      ...(this.byProblem.get(problemKey(input.problem)) ?? []),
    ]);
    if (vec) {
      const probTokens = tokenize(input.problem);
      for (const h of this.vectors.search(vec, 5)) {
        if (h.score < this.opts.duplicateCosine) break;
        const other = this.records.get(h.id);
        if (other && jaccard(probTokens, tokenize(other.problem)) >= this.opts.duplicateJaccard) candidates.add(h.id);
      }
    }
    return [...candidates].sort();
  }

  /** Fold `incoming` into `existing`, keeping every index consistent with the merged record. */
  private async applyMerge(existing: Experience, incoming: ExperienceInput, now: string, stats?: Experience["stats"]): Promise<Experience> {
    const merged = mergeInto(existing, incoming, now);
    if (stats) merged.stats = stats;
    const oldVec = this.vectors.get(existing.id) ?? null;
    this.unindexRecord(existing); // signals/context/fingerprint may have changed
    const changed = merged.fingerprint !== existing.fingerprint || merged.problem !== existing.problem;
    const vec = changed ? ((await this.embedOne(embedText(merged))) ?? oldVec) : oldVec;
    this.persist(merged, vec);
    return merged;
  }

  // ------------------------------------------------------------------ record

  async record(raw: ExperienceInput): Promise<RecordResult> {
    await this.sync();
    const input = sanitize(raw);
    const fp = fingerprint(input.problem, input.signals, input.context);
    const now = this.opts.now().toISOString();

    const vec = await this.embedOne(embedText(input));
    const ordered = this.duplicateCandidates(input, fp, vec);

    // Prefer merging into a record whose fix agrees with ours. Deterministic order.
    const target = ordered.map((id) => this.records.get(id)!).find((e) => e.kind === input.kind && sameFix(e.fix, input.fix, this.opts.sameFixJaccard));
    if (target) {
      const merged = await this.applyMerge(target, input, now);
      return { id: merged.id, action: "merged", merged_into: merged.id, fingerprint: fp };
    }

    // Genuinely new fix (possibly for a known symptom): create and link.
    const id = newId();
    const doc: Experience = {
      ...input,
      id,
      v: SCHEMA_VERSION,
      fingerprint: fp,
      related: ordered,
      dismissed_for: [],
      stats: { uses: 0, successes: 0, failures: 0, merged: 0, dismissed: 0, last_used: null },
      created: now,
      updated: now,
    };
    this.persist(doc, vec);
    for (const rid of ordered) {
      const r = this.records.get(rid)!;
      if (!r.related.includes(id)) this.persist({ ...r, related: [...r.related, id].sort(), updated: now }, this.vectors.get(rid) ?? null);
    }
    return ordered.length > 0
      ? { id, action: "linked", related: ordered, fingerprint: fp }
      : { id, action: "created", fingerprint: fp };
  }

  // --------------------------------------------------------------- reinforce

  async reinforce(id: string, worked: boolean, note?: string): Promise<Experience> {
    await this.sync();
    const doc = this.records.get(id);
    if (!doc) throw new Error(`no experience with id ${id}`);
    const now = this.opts.now().toISOString();
    const stats = {
      ...doc.stats,
      uses: doc.stats.uses + 1,
      successes: doc.stats.successes + (worked ? 1 : 0),
      failures: doc.stats.failures + (worked ? 0 : 1),
      last_used: now,
    };
    let avoid = doc.avoid;
    if (!worked && note) avoid = capList([...avoid, clean(note, 200)], 8);
    const updated: Experience = { ...doc, stats, avoid, updated: now };
    this.persist(updated, this.vectors.get(id) ?? null);
    return updated;
  }

  // ----------------------------------------------------------------- dismiss

  /**
   * "This record was surfaced for a problem it does not apply to." Remembers the query so the
   * record is never recalled for it again, and damps the record's fuzzy matches in general.
   * Says nothing about whether the fix works: that is `reinforce`'s job.
   */
  async dismiss(id: string, query: { problem: string; signals?: string[] }): Promise<Experience> {
    await this.sync();
    const doc = this.records.get(id);
    if (!doc) throw new Error(`no experience with id ${id}`);
    const keys = queryKeysFor(clean(query.problem, 240), (query.signals ?? []).map((s) => clean(s, 300)));
    const dismissed_for = capList(uniqueSorted([...doc.dismissed_for, ...keys]), 40);
    const updated: Experience = {
      ...doc,
      dismissed_for,
      stats: { ...doc.stats, dismissed: doc.stats.dismissed + 1 },
      updated: this.opts.now().toISOString(),
    };
    this.persist(updated, this.vectors.get(id) ?? null);
    return updated;
  }

  // ------------------------------------------------------------------- amend

  async amend(id: string, patch: Partial<ExperienceInput>): Promise<Experience> {
    await this.sync();
    const doc = this.records.get(id);
    if (!doc) throw new Error(`no experience with id ${id}`);
    const merged = sanitize(ExperienceInput.parse({ ...stripDerived(doc), ...patch }));
    const now = this.opts.now().toISOString();
    const fp = fingerprint(merged.problem, merged.signals, merged.context);
    const updated: Experience = { ...doc, ...merged, fingerprint: fp, updated: now };
    this.unindexRecord(doc);
    const vec = fp !== doc.fingerprint || merged.problem !== doc.problem ? await this.embedOne(embedText(updated)) : (this.vectors.get(id) ?? null);
    this.persist(updated, vec);
    return updated;
  }

  // ------------------------------------------------------------------ forget

  async forget(id: string): Promise<boolean> {
    await this.sync();
    const doc = this.records.get(id);
    if (!doc) return false;
    this.unindexRecord(doc);
    const ok = this.store.delete(id);
    this.lastDataVersion = this.store.dataVersion();
    return ok;
  }

  async get(id: string): Promise<Experience | null> {
    await this.sync();
    return this.records.get(id) ?? null;
  }

  // ------------------------------------------------------------- consolidate

  /**
   * Deterministic clustering of similar episodes. The agent uses the clusters to write
   * a single `rule` record that generalises them. No LLM call happens here.
   */
  async consolidate(threshold = 0.8, minSize = 3): Promise<Cluster[]> {
    await this.sync();
    const episodes = [...this.records.values()].filter((r) => r.kind === "episode").map((r) => r.id).sort();
    const parent = new Map<string, string>(episodes.map((id) => [id, id]));
    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    if (this.vectors.size > 0) {
      for (const [a, b] of this.vectors.similarPairs(threshold)) if (parent.has(a) && parent.has(b)) union(a, b);
    } else {
      const toks = new Map(episodes.map((id) => [id, tokenize(this.records.get(id)!.problem)]));
      for (let i = 0; i < episodes.length; i++)
        for (let j = i + 1; j < episodes.length; j++)
          if (jaccard(toks.get(episodes[i])!, toks.get(episodes[j])!) >= 0.5) union(episodes[i], episodes[j]);
    }
    const groups = new Map<string, string[]>();
    for (const id of episodes) {
      const r = find(id);
      groups.set(r, [...(groups.get(r) ?? []), id]);
    }
    const clusters: Cluster[] = [];
    for (const ids of groups.values()) {
      if (ids.length < minSize) continue;
      const docs = ids.map((id) => this.records.get(id)!);
      const ctxCounts = new Map<string, number>();
      for (const d of docs) for (const c of d.context) ctxCounts.set(c, (ctxCounts.get(c) ?? 0) + 1);
      const shared = [...ctxCounts.entries()].filter(([, n]) => n === docs.length).map(([c]) => c).sort();
      clusters.push({ ids: ids.sort(), problems: docs.map((d) => d.problem), shared_context: shared, size: ids.length });
    }
    clusters.sort((a, b) => b.size - a.size || (a.ids[0] < b.ids[0] ? -1 : 1));
    return clusters;
  }

  // ------------------------------------------------------------------- stats

  async stats(): Promise<Record<string, unknown>> {
    await this.sync();
    const all = [...this.records.values()];
    const byOutcome: Record<string, number> = { success: 0, partial: 0, failure: 0 };
    const byKind: Record<string, number> = { episode: 0, rule: 0 };
    let uses = 0;
    let successes = 0;
    let merged = 0;
    let dismissed = 0;
    const ctx = new Map<string, number>();
    for (const r of all) {
      byOutcome[r.outcome]++;
      byKind[r.kind]++;
      uses += r.stats.uses;
      successes += r.stats.successes;
      merged += r.stats.merged;
      dismissed += r.stats.dismissed;
      for (const c of r.context) ctx.set(c, (ctx.get(c) ?? 0) + 1);
    }
    const topContext = [...ctx.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10)
      .map(([tag, n]) => ({ tag, n }));
    return {
      records: all.length,
      by_kind: byKind,
      by_outcome: byOutcome,
      total_uses: uses,
      total_successes: successes,
      success_rate: uses > 0 ? round(successes / uses) : null,
      duplicates_prevented: merged,
      false_positives_dismissed: dismissed,
      embedded: this.vectors.size,
      embedding_model: this.embedderId,
      embedding_error: this.embedFailure,
      top_context: topContext,
      db: this.store.path,
    };
  }

  // ------------------------------------------------------------ portability

  async exportJsonl(): Promise<string> {
    await this.sync();
    return [...this.records.keys()]
      .sort()
      .map((id) => JSON.stringify(this.records.get(id)))
      .join("\n");
  }

  /**
   * Import records, idempotently.
   *   Same id already here: keep whichever was updated more recently.
   *   Already merged into a local record on a previous import: skip (or refresh content if newer),
   *     never re-add its stats.
   *   Duplicate by the same rules `record` uses: merge, summing stats once.
   *   Otherwise insert with its original id, stats and dates.
   */
  async importJsonl(text: string): Promise<{ inserted: number; updated: number; merged: number; skipped: number; errors: string[] }> {
    await this.sync();
    const out = { inserted: 0, updated: 0, merged: 0, skipped: 0, errors: [] as string[] };
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      let doc: Experience;
      try {
        doc = Experience.parse(JSON.parse(lines[i]));
      } catch (e) {
        out.errors.push(`line ${i + 1}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        continue;
      }
      const now = this.opts.now().toISOString();
      const existing = this.records.get(doc.id);
      if (existing) {
        if (existing.updated >= doc.updated) {
          out.skipped++;
          continue;
        }
        const oldVec = this.vectors.get(existing.id) ?? null;
        this.unindexRecord(existing);
        this.persist(doc, (await this.embedOne(embedText(doc))) ?? oldVec);
        out.updated++;
        continue;
      }

      // Seen before under another local id? Then its stats are already counted.
      const priorKey = `import:${doc.id}`;
      const prior = this.store.getMeta(priorKey);
      if (prior) {
        const { target: targetId, updated } = JSON.parse(prior) as { target: string; updated: string };
        const target = this.records.get(targetId);
        if (!target || updated >= doc.updated) {
          out.skipped++;
          continue;
        }
        await this.applyMerge(target, stripDerived(doc), now, { ...target.stats, merged: target.stats.merged });
        this.store.setMeta(priorKey, JSON.stringify({ target: targetId, updated: doc.updated }));
        out.updated++;
        continue;
      }

      const input = stripDerived(doc);
      const vec = await this.embedOne(embedText(doc));
      const target = this.duplicateCandidates(input, doc.fingerprint, vec)
        .map((id) => this.records.get(id)!)
        .find((r) => r.kind === doc.kind && sameFix(r.fix, doc.fix, this.opts.sameFixJaccard));
      if (target) {
        await this.applyMerge(target, input, now, {
          uses: target.stats.uses + doc.stats.uses,
          successes: target.stats.successes + doc.stats.successes,
          failures: target.stats.failures + doc.stats.failures,
          merged: target.stats.merged + doc.stats.merged + 1,
          dismissed: target.stats.dismissed + doc.stats.dismissed,
          last_used: [target.stats.last_used, doc.stats.last_used].filter(Boolean).sort().pop() ?? null,
        });
        this.store.setMeta(priorKey, JSON.stringify({ target: target.id, updated: doc.updated }));
        out.merged++;
        continue;
      }
      this.persist(doc, vec);
      out.inserted++;
    }
    return out;
  }
}

// ---------------------------------------------------------------- helpers

function newId(): string {
  return `x_${randomBytes(6).toString("hex")}`;
}

/** Deterministic identity of a query, used to remember false positives: its problem key plus each signal key. */
export function queryKeysFor(problem: string, signals: string[]): string[] {
  return uniqueSorted([`p:${problemKey(problem)}`, ...signalKeys(signals).map((k) => `s:${k}`)]);
}

/** Text the embedding model sees. Problem-side only, so queries and records are symmetric. */
export function embedText(e: { problem: string; signals: string[]; context: string[] }): string {
  const parts = [e.problem];
  if (e.signals.length) parts.push(e.signals.join("\n"));
  if (e.context.length) parts.push(e.context.join(" "));
  return parts.join("\n");
}

function lexicalText(e: Experience): string {
  return [e.problem, ...e.signals, ...e.context, e.root_cause ?? ""].join("\n");
}

function lexicalQuery(problem: string, signals: string[], context: string[]): string {
  return [problem, ...signals, ...context].join("\n");
}

function sanitize(input: ExperienceInput): ExperienceInput {
  return {
    ...input,
    problem: clean(input.problem, 240),
    signals: capList(uniqueSorted(input.signals.map((s) => clean(s, 300)).filter(Boolean)), 8),
    context: capList(uniqueSorted(input.context.map(normalizeTag).filter(Boolean)), 10),
    attempts: input.attempts.map((a) => ({ action: clean(a.action, 300), result: a.result })).slice(0, 12),
    fix: clean(input.fix, 600),
    avoid: capList([...new Set(input.avoid.map((a) => clean(a, 200)).filter(Boolean))], 8),
    root_cause: input.root_cause ? clean(input.root_cause, 300) : undefined,
    source: input.source,
  };
}

function stripDerived(doc: Experience): ExperienceInput {
  const { id: _i, v: _v, fingerprint: _f, related: _r, dismissed_for: _d, stats: _s, created: _c, updated: _u, ...input } = doc;
  return input;
}

function sameFix(a: string, b: string, threshold: number): boolean {
  if (!a || !b) return true; // one side has no fix yet: merging fills it in
  return jaccard(tokenize(a), tokenize(b)) >= threshold;
}

function capList(items: string[], max: number): string[] {
  return items.slice(0, max);
}

/**
 * Fold a new report into an existing record. Union lists, keep the better fix, bump merged,
 * recompute the fingerprint from the merged identity fields.
 * Existing list items are kept in preference to incoming ones when a cap is hit.
 */
function mergeInto(existing: Experience, incoming: ExperienceInput, now: string): Experience {
  const takeIncomingFix =
    (!existing.fix && !!incoming.fix) || (!!incoming.fix && MERGE_ORDER[incoming.outcome] > MERGE_ORDER[existing.outcome]);
  const attempts = [...existing.attempts];
  for (const a of incoming.attempts) if (!attempts.some((x) => x.action === a.action)) attempts.push(a);
  const signals = uniqueSorted(capList([...existing.signals, ...incoming.signals.filter((s) => !existing.signals.includes(s))], 8));
  const context = uniqueSorted(capList([...existing.context, ...incoming.context.filter((c) => !existing.context.includes(c))], 10));
  const problem = existing.problem;
  return {
    ...existing,
    problem,
    signals,
    context,
    fingerprint: fingerprint(problem, signals, context),
    attempts: attempts.slice(0, 12),
    fix: takeIncomingFix ? incoming.fix : existing.fix,
    avoid: capList([...new Set([...existing.avoid, ...incoming.avoid])], 8),
    root_cause: existing.root_cause ?? incoming.root_cause,
    outcome: MERGE_ORDER[incoming.outcome] > MERGE_ORDER[existing.outcome] ? incoming.outcome : existing.outcome,
    source: existing.source ?? incoming.source,
    stats: { ...existing.stats, merged: existing.stats.merged + 1 },
    updated: now,
  };
}
