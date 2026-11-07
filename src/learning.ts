/** Evidence and applicability are independent of retrieval similarity. No model or commands run here. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ExperienceInput, type Experience, type Applicability, type FeedbackInput } from "./schema.js";
import { clean, normalizeTag } from "./normalize.js";

export function contentOf(doc: Experience): ExperienceInput {
  return ExperienceInput.parse(doc);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
/** Source, observations and reported attempts can grow without moving a vote to another fix. */
export function revisionOf(doc: ExperienceInput): string {
  const { source, observations, attempts, ...claim } = ExperienceInput.parse(doc);
  return digest(claim);
}
export function applicabilityMatch(scope: Applicability = {}, environment: Applicability = {}): "match" | "unknown" | "mismatch" {
  let unknown = false;
  for (const [key, value] of Object.entries(scope)) {
    const actual = environment[key as keyof Applicability];
    if (!actual) unknown = true;
    else if (key === "project" ? canonicalProject(value) !== canonicalProject(actual) : value?.toLowerCase() !== actual.toLowerCase())
      return "mismatch";
  }
  return unknown ? "unknown" : "match";
}
export function sameScope(a: ExperienceInput, b: ExperienceInput): boolean {
  return stable(a.applicability ?? {}) === stable(b.applicability ?? {});
}
/** Do not erase a new condition or causal distinction merely because remedies share words. */
export function mergeCompatible(a: ExperienceInput, b: ExperienceInput): boolean {
  return (
    sameScope(a, b) &&
    digest(a.preconditions ?? []) === digest(b.preconditions ?? []) &&
    digest(a.claims ?? []) === digest(b.claims ?? []) &&
    (!a.root_cause || !b.root_cause || a.root_cause === b.root_cause)
  );
}
export function conflictingClaims(a: ExperienceInput, b: ExperienceInput): boolean {
  return sameScope(a, b) && !!a.claims?.some((x) => b.claims?.some((y) => x.key === y.key && x.value !== y.value));
}
export function snapshot(doc: Experience, reason: string, at: string) {
  return {
    revision: revisionOf(doc),
    input: contentOf(doc),
    at,
    reason,
    lifecycle: doc.lifecycle,
    superseded_by: doc.superseded_by,
    family: doc.family,
  };
}
export function evidenceSummary(doc: Experience, environment?: Applicability) {
  const revision = revisionOf(doc);
  const votes = (doc.votes ?? []).filter(
    (v) => v.revision === revision && (!environment || applicabilityMatch(v.environment, environment) === "match"),
  );
  const successes = votes.filter((v) => v.result === "verified-success").length;
  const failures = votes.filter((v) => v.result === "verified-failure").length;
  const helpful = votes.filter((v) => v.result === "diagnostic-help").length;
  const verified = votes.filter((v) => v.result === "verified-success" || v.result === "verified-failure");
  return {
    successes,
    failures,
    diagnostic_helps: helpful,
    last_verified:
      verified
        .map((v) => v.evidence!.observed_at)
        .sort()
        .at(-1) ?? null,
    level: successes
      ? votes.some((v) => v.result === "verified-success" && v.evidence?.level === "target-environment")
        ? "target-environment"
        : "local-test"
      : "reported",
    // Empty fixes and incomplete resolutions are useful leads, not verified solutions.
    confidence: doc.fix && doc.outcome === "success" ? (successes + 1) / (successes + failures + 2) : 0,
    basis: "agent-reported verification; independent execution identities are supplied by the host" as const,
  };
}
export function cleanFeedback(raw: FeedbackInput): FeedbackInput {
  return {
    ...raw,
    attempt_id: digest(raw.attempt_id), // Avoid persisting host/session identifiers in clear text.
    environment: cleanScope(raw.environment),
    evidence: raw.evidence ? cleanObservation(raw.evidence) : undefined,
    problem: raw.problem ? clean(raw.problem, 240) : undefined,
    signals: raw.signals?.map((s) => clean(s, 300)),
  };
}
export function cleanScope(scope: Applicability): Applicability {
  return Object.fromEntries(Object.entries(scope).map(([k, v]) => [k, clean(v!, 160).toLowerCase()]));
}
export function cleanObservation(o: NonNullable<ExperienceInput["observations"]>[number]) {
  return { ...o, summary: clean(o.summary, 600), reference: clean(o.reference, 300) };
}
/** Tag aliases only; a broad tag such as python is never an environment constraint. */
export function canonicalTag(tag: string): string {
  return normalizeTag(tag).replace(/^job-applications$/, "job-application");
}

/**
 * One spelling per project: the last path segment, lowercased, with spaces and underscores as hyphens.
 * "~/vesper root/personal projects/capability atlas", "Capability Atlas" and "capability_atlas" all
 * become "capability-atlas". Applied at match time, so stored revisions and their votes are unchanged.
 */
export function canonicalProject(value: string | undefined | null): string {
  if (!value) return "";
  const last = value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return last
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.+-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The project a hook runs in: the enclosing git repository's folder name, else the working folder's. */
export function projectFromCwd(cwd: string | undefined, exists: (p: string) => boolean = existsSync): string | undefined {
  if (!cwd) return undefined;
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (exists(`${dir}/.git`)) return canonicalProject(basename(dir)) || undefined;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return canonicalProject(basename(resolve(cwd))) || undefined;
}

/** Canonical projects in which a lesson was written or verified. */
export function projectsOf(doc: Experience): Set<string> {
  const out = new Set<string>();
  const own = canonicalProject(doc.applicability?.project);
  if (own) out.add(own);
  for (const v of doc.votes ?? []) {
    const p = canonicalProject(v.environment?.project);
    if (p) out.add(p);
  }
  return out;
}
