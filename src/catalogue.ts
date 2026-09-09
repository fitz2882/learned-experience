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
import { dot, VectorIndex } from "./index/vector.js";
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
  FeedbackInput,
  type Applicability,
} from "./schema.js";
import { Store } from "./store.js";
import {
  applicabilityMatch,
  canonicalTag,
  cleanFeedback,
  cleanObservation,
  cleanScope,
  conflictingClaims,
  mergeCompatible,
  contentOf,
  digest,
  evidenceSummary,
  revisionOf,
  sameScope,
  snapshot,
} from "./learning.js";
import { Maintenance, type Review } from "./maintenance.js";

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
  environment?: Applicability;
  include_history?: boolean;
}

export interface RecallResult {
  hits: RecallHit[];
  searched: number;
  semantic: boolean;
  maintenance_pending?: number;
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
  private readonly maintenance: Maintenance;

  constructor(
    private readonly store: Store,
    private readonly embedder: Embedder | null,
    opts: CatalogueOptions = {},
  ) {
    this.maintenance = new Maintenance(store, opts.now ?? (() => new Date()));
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
    const dataVersion = this.store.dataVersion();
    const indexedIds = [...this.allIndexedIds()];
    this.records.clear();
    this.byFingerprint.clear();
    this.bySignal.clear();
    this.byProblem.clear();
    const rows = this.store.all();
    const toEmbed: Experience[] = [];
    // Rebuild in-memory indexes from scratch.
    for (const id of indexedIds) {
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
    this.lastDataVersion = dataVersion;
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

  private persist(doc: Experience, vec: Float32Array | null, expected?: Experience): void {
    if (expected) this.store.replace(expected, doc, vec, vec ? this.embedderId : null);
    else this.store.upsert(doc, vec, vec ? this.embedderId : null);
    const previous = this.records.get(doc.id);
    if (previous) this.unindexRecord(previous);
    this.indexRecord(doc);
    if (vec) this.vectors.add(doc.id, vec);
  }

  // ------------------------------------------------------------------ recall

  async recall(q: RecallQuery): Promise<RecallResult> {
    await this.sync();
    const limit = Math.max(1, Math.min(q.limit ?? 5, 25));
    const minScore = q.min_score ?? 0.45;
    const signals = (q.signals ?? []).map((s) => clean(s, 300));
    const context = (q.context ?? []).map(canonicalTag).filter(Boolean);
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
    const queryTokens = tokenize(lexicalQuery(problem, signals, context));
    const coverage = (id: string) => {
      const terms = new Set(tokenize(lexicalText(this.records.get(id)!)));
      return queryTokens.length ? queryTokens.filter((t) => terms.has(t)).length / queryTokens.length : 0;
    };
    let denseHits: Array<{ id: string; score: number }> = [];

    // 3. Dense layer.
    const qv = await this.embedOne(embedText({ problem, signals, context }));
    if (qv) denseHits = this.vectors.search(qv, 50);
    const wD = qv ? this.opts.denseWeight : 0;
    const wL = qv ? 1 - this.opts.denseWeight : 1;

    for (const h of lexHits) bump(h.id, wL * Math.sqrt(coverage(h.id)), "lexical");
    for (const h of denseHits) if (h.score > 0) bump(h.id, wD * h.score, "semantic");

    const queryKeys = new Set(queryKeysFor(problem, signals));
    const hits: RecallHit[] = [];
    for (const [id, { score, via }] of scores) {
      const doc = this.records.get(id);
      if (!doc || !kinds.has(doc.kind)) continue;
      if (!q.include_history && doc.lifecycle === "superseded") continue;
      const applicability = applicabilityMatch(doc.applicability, q.environment);
      if (applicability === "mismatch") continue;
      if (doc.dismissed_for.some((k) => queryKeys.has(k))) continue; // known false positive for this query
      if (
        doc.votes?.some(
          (v) =>
            v.revision === revisionOf(doc) &&
            v.result === "irrelevant" &&
            v.problem &&
            applicabilityMatch(v.environment, q.environment) === "match" &&
            queryKeysFor(v.problem, v.signals ?? []).some((k) => queryKeys.has(k)),
        )
      )
        continue;
      const exact = via.has("fingerprint");
      // A generic matching word is not enough; allow strong semantic paraphrases independently.
      const dense = denseHits.find((h) => h.id === id)?.score ?? 0;
      if (!exact && minScore >= 0.4 && coverage(id) < 0.25 && dense < 0.65) continue;
      const base = exact ? 1 : Math.min(score, 1);
      const evidence = evidenceSummary(doc, q.environment);
      const reliability = evidence.confidence || 0.5;
      const final = base * (0.85 + 0.15 * reliability);
      if (!exact && final < minScore) continue;
      const disputed = [...this.records.values()].some(
        (other) => other.id !== doc.id && other.lifecycle !== "superseded" && conflictingClaims(doc, other),
      );
      hits.push({
        ...toRecallHit(doc, { score: final, exact, via: [...via].sort() }),
        confidence: round(evidence.confidence),
        revision: revisionOf(doc),
        evidence,
        applicability,
        constraints: doc.applicability,
        preconditions: doc.preconditions ?? [],
        lifecycle: disputed ? "disputed" : (doc.lifecycle ?? "active"),
        recommendation:
          doc.lifecycle === "superseded"
            ? "historical"
            : !doc.fix || doc.outcome !== "success"
              ? "diagnostic-lead"
              : disputed || doc.lifecycle === "disputed" || doc.lifecycle === "needs-review" || applicability === "unknown"
                ? "check-before-use"
                : "candidate-fix",
      });
    }
    hits.sort((a, b) => b.match.score - a.match.score || (a.id < b.id ? -1 : 1));
    const families = new Set<string>();
    const diverse = hits.filter((h) => {
      const family = this.records.get(h.id)!.family ?? h.id;
      if (families.has(family)) return false;
      families.add(family);
      return true;
    });
    return {
      hits: diverse.slice(0, limit),
      searched: this.records.size,
      semantic: qv !== null,
      maintenance_pending: this.maintenance.queue(100000).length,
    };
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
  private async applyMerge(
    existing: Experience,
    incoming: ExperienceInput,
    now: string,
    stats?: Experience["stats"],
    imported?: Experience,
  ): Promise<Experience> {
    const merged = mergeInto(existing, incoming, now);
    if (stats) merged.stats = stats;
    if (imported) mergeEvidence(merged, imported);
    const oldVec = this.vectors.get(existing.id) ?? null;
    const changed = merged.fingerprint !== existing.fingerprint || merged.problem !== existing.problem;
    const vec = changed ? ((await this.embedOne(embedText(merged))) ?? oldVec) : oldVec;
    this.persist(merged, vec, existing);
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
    const target = ordered
      .map((id) => this.records.get(id)!)
      .find(
        (e) =>
          e.lifecycle !== "superseded" &&
          e.kind === input.kind &&
          mergeCompatible(e, input) &&
          !conflictingClaims(e, input) &&
          sameFix(e.fix, input.fix, this.opts.sameFixJaccard),
      );
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
    return ordered.length > 0 ? { id, action: "linked", related: ordered, fingerprint: fp } : { id, action: "created", fingerprint: fp };
  }

  // --------------------------------------------------------------- reinforce

  async reinforce(id: string, worked: boolean, note?: string): Promise<Experience> {
    await this.sync();
    const updated = this.store.update(id, (doc) => {
      const stats = {
        ...doc.stats,
        uses: doc.stats.uses + 1,
        successes: doc.stats.successes + (worked ? 1 : 0),
        failures: doc.stats.failures + (worked ? 0 : 1),
        last_used: this.opts.now().toISOString(),
      };
      const avoid = !worked && note ? capList([...doc.avoid, clean(note, 200)], 8) : doc.avoid;
      return {
        ...doc,
        stats,
        avoid,
        history:
          digest(avoid) !== digest(doc.avoid)
            ? [...(doc.history ?? []), snapshot(doc, "legacy-failure-note", this.opts.now().toISOString())]
            : doc.history,
        updated: this.opts.now().toISOString(),
      };
    });
    this.lastDataVersion = -1;
    // Legacy reported outcomes are retained, but never become verified votes.
    return updated;
  }

  // ----------------------------------------------------------------- dismiss

  async beginAttempt(id: string, executionId: string, environment: Applicability) {
    await this.sync();
    const doc = this.records.get(id);
    if (!doc) throw new Error(`no experience with id ${id}`);
    const scope = cleanScope(environment);
    if (doc.lifecycle === "superseded") throw new Error("lesson is superseded; recall its replacement");
    if (applicabilityMatch(doc.applicability, scope) !== "match")
      throw new Error("supply an environment matching every applicability constraint");
    return {
      id,
      revision: revisionOf(doc),
      attempt_id: digest(executionId),
      environment: scope,
      instruction:
        "All observers of this execution must reuse this attempt_id. Report feedback only after checking the result; no outcome is inferred.",
    };
  }

  async feedback(raw: FeedbackInput) {
    const parsed = FeedbackInput.parse(raw);
    const input = cleanFeedback(parsed);
    const updated = this.store.update(input.id, (doc) => {
      const currentRevision = revisionOf(doc);
      const subject = currentRevision === input.revision ? doc : doc.history?.find((h) => h.revision === input.revision)?.input;
      if (!subject) throw new Error("unknown lesson revision; reread the lesson");
      const duplicate = doc.votes?.find((v) => v.revision === input.revision && v.attempt_id === input.attempt_id);
      if (duplicate) {
        const { recorded_at, ...prior } = duplicate;
        const { id, ...incoming } = input;
        if (digest(prior) !== digest(incoming))
          throw new Error("attempt already has different feedback; do not count observers as new attempts");
        return doc;
      }
      if (input.result.startsWith("verified-")) {
        if (!subject.fix) throw new Error("an empty fix cannot receive a solution verification vote; use diagnostic-help");
        if (!input.evidence || input.evidence.level === "reported")
          throw new Error("verified feedback requires test or target-environment evidence");
        if (applicabilityMatch(subject.applicability, input.environment) !== "match")
          throw new Error("verification environment must match every applicability constraint");
      }
      if (input.evidence && Date.parse(input.evidence.observed_at) > this.opts.now().getTime() + 60000)
        throw new Error("verification evidence is in the future");
      if (input.result === "irrelevant" && !input.problem) throw new Error("irrelevant feedback requires the actual query");
      const { id, ...vote } = input;
      return {
        ...doc,
        votes: [...(doc.votes ?? []), { ...vote, recorded_at: this.opts.now().toISOString() }],
        updated: this.opts.now().toISOString(),
      };
    });
    this.lastDataVersion = -1;
    return { id: updated.id, revision: input.revision, evidence: evidenceSummary(updated, input.environment) };
  }

  async maintain(limit = 20, budgetMs = 100) {
    await this.sync();
    const result = this.maintenance.run(limit, budgetMs, (a, b) => {
      const x = this.vectors.get(a),
        y = this.vectors.get(b);
      return x && y && x.length === y.length ? dot(x, y) : 0;
    });
    return { ...result, jobs: this.maintenance.queue(5) };
  }

  maintenanceQueue(limit = 10, id?: string) {
    return this.maintenance.queue(limit, id);
  }

  async resolveMaintenance(review: Review) {
    const result = this.maintenance.resolve(review);
    this.lastDataVersion = -1;
    return result;
  }

  async restore(id: string, revision: string, expectedRevision: string, reason: string) {
    await this.sync();
    const doc = this.records.get(id);
    if (!doc) throw new Error(`no experience with id ${id}`);
    if (revisionOf(doc) !== expectedRevision) throw new Error("revision changed; reread before restoring");
    const prior = [...(doc.history ?? [])].reverse().find((h) => h.revision === revision && h.reason !== "merge-report");
    if (!prior) throw new Error("no historical revision to restore");
    const at = this.opts.now().toISOString();
    const next: Experience = {
      ...doc,
      root_cause: undefined,
      source: undefined,
      applicability: undefined,
      preconditions: undefined,
      claims: undefined,
      observations: undefined,
      ...prior.input,
      fingerprint: fingerprint(prior.input.problem, prior.input.signals, prior.input.context),
      lifecycle: prior.lifecycle,
      superseded_by: prior.superseded_by,
      family: prior.family,
      history: [...(doc.history ?? []), snapshot(doc, `restore: ${clean(reason, 200)}`, at)],
      updated: at,
    };
    const vec = await this.embedOne(embedText(next));
    this.persist(next, vec, doc);
    this.lastDataVersion = -1;
    return next;
  }

  /**
   * "This record was surfaced for a problem it does not apply to." Remembers the query so the
   * record is never recalled for it again, and damps the record's fuzzy matches in general.
   * Says nothing about whether the fix works: that is `reinforce`'s job.
   */
  async dismiss(id: string, query: { problem: string; signals?: string[] }): Promise<Experience> {
    await this.sync();
    const keys = queryKeysFor(
      clean(query.problem, 240),
      (query.signals ?? []).map((s) => clean(s, 300)),
    );
    const updated = this.store.update(id, (doc) => {
      if (keys.every((k) => doc.dismissed_for.includes(k))) return doc;
      return {
        ...doc,
        dismissed_for: uniqueSorted([...doc.dismissed_for, ...keys]),
        stats: { ...doc.stats, dismissed: doc.stats.dismissed + 1 },
        updated: this.opts.now().toISOString(),
      };
    });
    this.lastDataVersion = -1;
    return updated;
  }

  // ------------------------------------------------------------------- amend

  async amend(id: string, patch: Partial<ExperienceInput>, expectedRevision?: string): Promise<Experience> {
    await this.sync();
    const doc = this.records.get(id);
    if (!doc) throw new Error(`no experience with id ${id}`);
    if (expectedRevision && revisionOf(doc) !== expectedRevision) throw new Error("revision changed; reread before amending");
    const merged = sanitize(ExperienceInput.parse({ ...stripDerived(doc), ...patch }));
    const now = this.opts.now().toISOString();
    const fp = fingerprint(merged.problem, merged.signals, merged.context);
    const updated: Experience = {
      ...doc,
      ...merged,
      fingerprint: fp,
      updated: now,
      history: [...(doc.history ?? []), snapshot(doc, "amend", now)],
      family: revisionOf(doc) !== revisionOf(merged) ? undefined : doc.family,
    };
    const vec =
      fp !== doc.fingerprint || merged.problem !== doc.problem ? await this.embedOne(embedText(updated)) : (this.vectors.get(id) ?? null);
    this.persist(updated, vec, doc);
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
    const episodes = [...this.records.values()]
      .filter((r) => r.kind === "episode")
      .map((r) => r.id)
      .sort();
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
      const shared = [...ctxCounts.entries()]
        .filter(([, n]) => n === docs.length)
        .map(([c]) => c)
        .sort();
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
    let verifiedSuccesses = 0,
      verifiedFailures = 0,
      diagnosticHelps = 0,
      withVerification = 0;
    const ctx = new Map<string, number>();
    for (const r of all) {
      byOutcome[r.outcome]++;
      byKind[r.kind]++;
      uses += r.stats.uses;
      successes += r.stats.successes;
      merged += r.stats.merged;
      dismissed += r.stats.dismissed;
      const evidence = evidenceSummary(r);
      verifiedSuccesses += evidence.successes;
      verifiedFailures += evidence.failures;
      diagnosticHelps += evidence.diagnostic_helps;
      if (evidence.successes + evidence.failures) withVerification++;
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
      verified_successes: verifiedSuccesses,
      verified_failures: verifiedFailures,
      diagnostic_helps: diagnosticHelps,
      records_with_verification: withVerification,
      verification_coverage: all.length ? round(withVerification / all.length) : 0,
      verification_basis: "agent-reported tests; historical reinforce counts are not verified votes",
      maintenance_pending: this.maintenance.queue(100000).length,
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
   *   Same id already here: union evidence, preserve competing content as review candidates.
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
        const cleanInput = sanitize(contentOf(doc));
        const history = doc.history?.map((h) => ({ ...h, input: sanitize(h.input), reason: clean(h.reason, 200) }));
        const votes = doc.votes?.map((v) => ({
          ...v,
          environment: cleanScope(v.environment),
          problem: v.problem ? clean(v.problem, 240) : undefined,
          signals: v.signals?.map((s) => clean(s, 300)),
          evidence: v.evidence ? cleanObservation(v.evidence) : undefined,
        }));
        doc = {
          ...doc,
          ...cleanInput,
          history,
          votes,
          reviews: doc.reviews?.map((r) => ({ ...r, evidence: cleanObservation(r.evidence) })),
        };
        for (const v of doc.votes ?? []) {
          const subject = v.revision === revisionOf(doc) ? doc : doc.history?.find((h) => h.revision === v.revision)?.input;
          if (!subject) throw new Error("imported vote references an unknown revision");
          if (v.result.startsWith("verified-") && (!subject.fix || applicabilityMatch(subject.applicability, v.environment) !== "match"))
            throw new Error("invalid imported verification scope or empty fix");
        }
      } catch (e) {
        out.errors.push(`line ${i + 1}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        continue;
      }
      const now = this.opts.now().toISOString();
      const existing = this.records.get(doc.id);
      if (existing) {
        if (digest(existing) === digest(doc)) {
          out.skipped++;
          continue;
        }
        // Different content is a candidate, not a last-writer-wins correction.
        const changedContent = revisionOf(existing) !== revisionOf(doc);
        let next = changedContent || existing.updated >= doc.updated ? { ...existing } : { ...doc };
        const other = next.updated === existing.updated && digest(contentOf(next)) === digest(contentOf(existing)) ? doc : existing;
        const superseded = existing.lifecycle === "superseded" ? existing : doc.lifecycle === "superseded" ? doc : null;
        if (superseded) {
          const active = superseded === existing ? doc : existing;
          const restored = active.history?.some(
            (h) => h.reason.startsWith("restore:") && h.lifecycle === "superseded" && h.superseded_by === superseded.superseded_by,
          );
          if (!restored) next = { ...next, lifecycle: "superseded", superseded_by: superseded.superseded_by };
        }
        mergeEvidence(next, other);
        if (changedContent && !next.history?.some((h) => h.reason === "merge-report" && h.revision === revisionOf(doc)))
          next.history = [
            ...(next.history ?? []),
            { revision: revisionOf(doc), input: contentOf(doc), at: doc.updated, reason: "merge-report" },
          ];
        if (digest(next) === digest(existing)) {
          out.skipped++;
          continue;
        }
        const oldVec = this.vectors.get(existing.id) ?? null;
        this.persist(next, (await this.embedOne(embedText(next))) ?? oldVec, existing);
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
        await this.applyMerge(target, stripDerived(doc), now, { ...target.stats, merged: target.stats.merged }, doc);
        this.store.setMeta(priorKey, JSON.stringify({ target: targetId, updated: doc.updated }));
        out.updated++;
        continue;
      }

      const input = stripDerived(doc);
      const vec = await this.embedOne(embedText(doc));
      const target = this.duplicateCandidates(input, doc.fingerprint, vec)
        .map((id) => this.records.get(id)!)
        .find(
          (r) =>
            r.lifecycle !== "superseded" &&
            r.kind === doc.kind &&
            mergeCompatible(r, doc) &&
            !conflictingClaims(r, doc) &&
            sameFix(r.fix, doc.fix, this.opts.sameFixJaccard),
        );
      if (target) {
        await this.applyMerge(
          target,
          input,
          now,
          {
            uses: target.stats.uses + doc.stats.uses,
            successes: target.stats.successes + doc.stats.successes,
            failures: target.stats.failures + doc.stats.failures,
            merged: target.stats.merged + doc.stats.merged + 1,
            dismissed: target.stats.dismissed + doc.stats.dismissed,
            last_used: [target.stats.last_used, doc.stats.last_used].filter(Boolean).sort().pop() ?? null,
          },
          doc,
        );
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
    applicability: input.applicability ? cleanScope(input.applicability) : undefined,
    preconditions: input.preconditions?.map((s) => clean(s, 200)),
    claims: input.claims?.map((c) => ({ key: clean(c.key, 100), value: clean(c.value, 200) })),
    observations: input.observations?.map(cleanObservation),
  };
}

function stripDerived(doc: Experience): ExperienceInput {
  const { id: _i, v: _v, fingerprint: _f, related: _r, dismissed_for: _d, stats: _s, created: _c, updated: _u, ...input } = doc;
  return ExperienceInput.parse(input);
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
    history: uniqueHistory([
      ...(existing.history ?? []),
      snapshot(existing, "before-merge", now),
      { revision: revisionOf(incoming), input: incoming, at: now, reason: "merge-report" },
    ]),
    observations:
      existing.observations || incoming.observations
        ? [...(existing.observations ?? []), ...(incoming.observations ?? [])].slice(-30)
        : undefined,
  };
}

/** Union verification events, never add counters for the same execution. */
function mergeEvidence(target: Experience, source: Experience): void {
  const votes = new Map((target.votes ?? []).map((v) => [`${v.revision}:${v.attempt_id}`, v]));
  for (const vote of source.votes ?? []) {
    const key = `${vote.revision}:${vote.attempt_id}`;
    const previous = votes.get(key);
    if (previous) {
      const { recorded_at: a, ...x } = previous;
      const { recorded_at: b, ...y } = vote;
      if (digest(x) !== digest(y)) throw new Error("conflicting feedback for the same execution identity");
    } else votes.set(key, vote);
  }
  if (votes.size) target.votes = [...votes.values()];
  const histories = [...(target.history ?? []), ...(source.history ?? [])];
  if (revisionOf(target) !== revisionOf(source)) histories.push(snapshot(source, "import-source", source.updated));
  if (histories.length) target.history = [...new Map(histories.map((h) => [digest(h), h])).values()];
  const reviews = [...(target.reviews ?? []), ...(source.reviews ?? [])];
  if (reviews.length) target.reviews = [...new Map(reviews.map((r) => [digest(r), r])).values()];
}

function uniqueHistory(history: NonNullable<Experience["history"]>): NonNullable<Experience["history"]> {
  const unique = new Map<string, (typeof history)[number]>();
  for (const item of history) {
    const { at, ...content } = item;
    const key = digest(content);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}
