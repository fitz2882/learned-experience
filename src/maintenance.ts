import { type Experience, type ExperienceInput, Observation } from "./schema.js";
import { Store } from "./store.js";
import { jaccard, tokenize } from "./normalize.js";
import { cleanObservation, conflictingClaims, digest, mergeCompatible, revisionOf, sameScope, snapshot } from "./learning.js";

export interface MaintenanceJob {
  key: string;
  kind: "incomplete" | "temporary-status" | "unverified" | "conflict" | "duplicate" | "candidate" | "failed-verification";
  id: string;
  revision: string;
  related_id?: string;
  related_revision?: string;
  reason: string;
  created: string;
  candidate_revision?: string;
}
export type Review = {
  key: string;
  action: "dismiss" | "supersede" | "consolidate" | "accept-candidate";
  winner_id?: string;
  evidence: NonNullable<ExperienceInput["observations"]>[number];
};

/** Incremental local queue. Suggestions are not treated as facts or executable instructions. */
export class Maintenance {
  constructor(
    private store: Store,
    private now: () => Date,
  ) {}
  queue(limit = 10, id?: string): MaintenanceJob[] {
    const priority: Record<MaintenanceJob["kind"], number> = {
      conflict: 0,
      candidate: 1,
      "failed-verification": 2,
      duplicate: 3,
      unverified: 4,
      "temporary-status": 5,
      incomplete: 6,
    };
    return this.store
      .jobs<MaintenanceJob>()
      .filter((job) => {
        if (id && job.id !== id && job.related_id !== id) return false;
        const doc = this.store.get(job.id)?.doc;
        const other = job.related_id ? this.store.get(job.related_id)?.doc : undefined;
        return (
          doc &&
          doc.lifecycle !== "superseded" &&
          revisionOf(doc) === job.revision &&
          (!job.related_id || (other && other.lifecycle !== "superseded" && revisionOf(other) === job.related_revision))
        );
      })
      .sort((a, b) => priority[a.kind] - priority[b.kind] || a.created.localeCompare(b.created) || a.key.localeCompare(b.key))
      .slice(0, limit);
  }
  run(limit = 20, budgetMs = 100, similarity: (a: string, b: string) => number = () => 0) {
    const started = performance.now();
    let processed = 0;
    const all = this.store.all().map((r) => r.doc);
    const cursor = this.store.getMeta("maintenance:cursor") ?? "";
    const docs = [...all.filter((d) => d.id > cursor), ...all.filter((d) => d.id <= cursor)];
    for (const doc of docs.slice(0, Math.max(1, Math.min(limit, 100)))) {
      if (processed && performance.now() - started >= budgetMs) break;
      if (doc.lifecycle !== "superseded") {
        const propose = (kind: MaintenanceJob["kind"], reason: string, other?: Experience, candidateRevision?: string) => {
          const revision = revisionOf(doc);
          const key = digest([kind, doc.id, revision, other?.id, other ? revisionOf(other) : null, candidateRevision]);
          if (doc.reviews?.some((r) => r.key === key && (kind !== "failed-verification" || r.feedback_count === (doc.votes ?? []).length)))
            return;
          this.store.putJob(key, {
            key,
            kind,
            id: doc.id,
            revision,
            related_id: other?.id,
            related_revision: other ? revisionOf(other) : undefined,
            reason,
            candidate_revision: candidateRevision,
            created: this.now().toISOString(),
          });
        };
        if (!doc.fix) propose("incomplete", "No solution recorded. Preserve this as a diagnostic lead until a fix is verified.");
        if (/\b(pending|not installed|not merged|not yet verified|installation in progress|awaits installation)\b/i.test(doc.fix))
          propose(
            "temporary-status",
            "Fix includes temporary status. Check current evidence; move status to a dated observation when revising.",
          );
        const verified = (doc.votes ?? []).filter((v) => v.revision === revisionOf(doc) && v.result === "verified-success");
        if (doc.votes?.some((v) => v.revision === revisionOf(doc) && v.result === "verified-failure"))
          propose(
            "failed-verification",
            "A checked application failed. Compare the environment and test evidence before revising the recommendation.",
          );
        const last = verified
          .map((v) => v.evidence?.observed_at ?? "")
          .sort()
          .at(-1);
        if (doc.applicability?.version && (!last || this.now().getTime() - Date.parse(last) > 30 * 86400000))
          propose("unverified", "Version-specific advice has no recent verification. Revalidate before broadening its applicability.");
        const candidate = [...(doc.history ?? [])]
          .reverse()
          .find((h) => h.reason === "merge-report" && h.revision !== revisionOf(doc) && h.input.fix !== doc.fix);
        if (candidate)
          propose(
            "candidate",
            "A merged report supplied different wording or a correction. Compare its evidence with the active fix.",
            undefined,
            candidate.revision,
          );
        for (const other of all) {
          if (other.id <= doc.id || other.lifecycle === "superseded" || !sameScope(doc, other)) continue;
          if (conflictingClaims(doc, other))
            propose("conflict", "Same scoped claim has incompatible values. Neither recency nor votes alone resolve this.", other);
          else {
            const sim = similarity(doc.id, other.id);
            const lexical = jaccard(tokenize(doc.problem), tokenize(other.problem));
            const fix = jaccard(tokenize(doc.fix), tokenize(other.fix));
            if (
              doc.fix &&
              other.fix &&
              (sim >= 0.8 || lexical >= 0.35) &&
              fix >= 0.25 &&
              doc.family !== other.id &&
              (!doc.family || doc.family !== other.family)
            )
              propose("duplicate", "Similar problem and remedy; verify equivalence and preconditions before grouping.", other);
          }
        }
      }
      this.store.setMeta("maintenance:cursor", doc.id);
      processed++;
    }
    // Drop jobs invalidated by amendments/deletions so the durable queue stays bounded by live revisions.
    for (const job of this.store.jobs<MaintenanceJob>()) {
      const d = this.store.get(job.id)?.doc;
      const other = job.related_id ? this.store.get(job.related_id)?.doc : undefined;
      if (
        !d ||
        d.lifecycle === "superseded" ||
        revisionOf(d) !== job.revision ||
        (job.related_id && (!other || other.lifecycle === "superseded" || revisionOf(other) !== job.related_revision))
      )
        this.store.finishJob(job.key);
    }
    return { processed, pending: this.queue(100000).length, elapsed_ms: Math.round(performance.now() - started) };
  }
  resolve(review: Review) {
    const evidence = cleanObservation(Observation.parse(review.evidence));
    if (Date.parse(evidence.observed_at) > this.now().getTime() + 60000) throw new Error("review evidence is in the future");
    return this.store.transaction(() => {
      const job = this.store.jobs<MaintenanceJob>().find((j) => j.key === review.key);
      if (!job) {
        const done = this.store
          .all()
          .some((r) =>
            r.doc.reviews?.some(
              (x) =>
                x.key === review.key &&
                x.action === review.action &&
                x.winner_id === review.winner_id &&
                digest(x.evidence) === digest(evidence),
            ),
          );
        if (done) return { action: review.action, duplicate: true };
        throw new Error("no pending maintenance job; reread the queue");
      }
      let row = this.store.get(job.id)!;
      let other = job.related_id ? this.store.get(job.related_id) : null;
      if (!row || revisionOf(row.doc) !== job.revision || (job.related_id && (!other || revisionOf(other.doc) !== job.related_revision)))
        throw new Error("maintenance inputs changed; reread the queue");
      if (row.doc.lifecycle === "superseded" || other?.doc.lifecycle === "superseded")
        throw new Error("maintenance inputs are no longer active; use explicit restore if intended");
      if (review.winner_id && (!other || ![row.doc.id, other.doc.id].includes(review.winner_id)))
        throw new Error("winner_id must identify one of the reviewed records");
      if (review.winner_id === row.doc.id && other) [row, other] = [other, row];
      let doc = row.doc;
      const at = this.now().toISOString();
      if (review.action === "supersede" || review.action === "consolidate") {
        if (!other || !sameScope(doc, other.doc)) throw new Error("review requires two records with identical applicability");
        if (other.doc.lifecycle === "superseded" || !other.doc.fix) throw new Error("replacement must be active and contain a fix");
        if (evidence.level === "reported") throw new Error("replacement requires test or target-environment evidence");
        if (review.action === "consolidate" && conflictingClaims(doc, other.doc))
          throw new Error("conflicting claims cannot be consolidated");
        if (review.action === "consolidate" && digest(doc.preconditions ?? []) !== digest(other.doc.preconditions ?? []))
          throw new Error("different preconditions cannot be consolidated");
        doc = { ...doc, history: [...(doc.history ?? []), snapshot(doc, review.action, at)] };
        if (review.action === "supersede") doc = { ...doc, lifecycle: "superseded", superseded_by: other.doc.id };
        else {
          const family = other.doc.family ?? other.doc.id;
          doc = { ...doc, family };
          this.store.upsert(
            { ...other.doc, family, history: [...(other.doc.history ?? []), snapshot(other.doc, "consolidate", at)], updated: at },
            other.embedding,
            other.embedModel,
          );
        }
      } else if (review.action === "accept-candidate") {
        const candidate =
          job.kind === "candidate"
            ? doc.history?.find((h) => h.reason === "merge-report" && h.revision === job.candidate_revision)
            : undefined;
        if (!candidate) throw new Error("no candidate revision");
        if (!mergeCompatible(doc, candidate.input))
          throw new Error("candidate changes scope or conditions; use an explicit complete amendment");
        // Explicit amend regenerates embeddings; queue review must not change indexed identity.
        if (evidence.level === "reported") throw new Error("accepting a correction requires verification evidence");
        doc = {
          ...doc,
          history: [...(doc.history ?? []), snapshot(doc, "accept-candidate", at)],
          fix: candidate.input.fix,
          root_cause: candidate.input.root_cause,
          outcome: candidate.input.outcome,
          observations: [...(doc.observations ?? []), evidence].slice(-30),
          lifecycle: "active",
          superseded_by: undefined,
          family: undefined,
        };
      }
      doc = {
        ...doc,
        reviews: [
          ...(doc.reviews ?? []),
          { key: review.key, action: review.action, winner_id: review.winner_id, feedback_count: (doc.votes ?? []).length, evidence, at },
        ],
        updated: at,
      };
      this.store.upsert(doc, row.embedding, row.embedModel);
      this.store.finishJob(job.key);
      return { action: review.action, id: doc.id, revision: revisionOf(doc), duplicate: false };
    });
  }
}
