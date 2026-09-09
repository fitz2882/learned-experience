/**
 * The standardised experience record. This is the interoperable contract:
 * every field is small, typed, and meaningful to any model reading it.
 * Keep it minimal. Every extra field costs context tokens on every recall.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const Outcome = z.enum(["success", "partial", "failure"]);
export type Outcome = z.infer<typeof Outcome>;

export const Kind = z.enum(["episode", "rule"]);
export type Kind = z.infer<typeof Kind>;

export const AttemptResult = z.enum(["worked", "failed", "partial"]);

export const Attempt = z.object({
  action: z.string().min(1).max(300).describe("What was tried, one line"),
  result: AttemptResult.describe("Did it work"),
});
export type Attempt = z.infer<typeof Attempt>;

export const Source = z.object({
  agent: z.string().max(60).optional().describe("Agent/host name, e.g. claude-code, cursor, langgraph"),
  model: z.string().max(80).optional().describe("Model id that produced the record"),
});

export const Stats = z.object({
  uses: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative().describe("How many duplicate reports were folded into this record"),
  dismissed: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("How many times this record was surfaced for a problem it did not apply to"),
  last_used: z.string().nullable(),
});
export type Stats = z.infer<typeof Stats>;

/** Exact constraints, not free-form tags. Unknown versions never count as verified matches. */
export const Applicability = z
  .object({
    project: z.string().max(160).optional(),
    product: z.string().max(80).optional(),
    version: z.string().max(80).optional(),
    platform: z.string().max(80).optional(),
  })
  .strict();
export type Applicability = z.infer<typeof Applicability>;
export const Observation = z.object({
  summary: z.string().min(3).max(600),
  reference: z.string().min(3).max(300),
  observed_at: z.string().datetime(),
  level: z.enum(["reported", "local-test", "target-environment"]),
});
export const Claim = z.object({ key: z.string().min(1).max(100), value: z.string().min(1).max(200) });
export const FeedbackResult = z.enum(["verified-success", "verified-failure", "diagnostic-help", "relevant", "irrelevant", "unverified"]);
export const FeedbackInput = z.object({
  id: z.string(),
  revision: z.string().min(1),
  attempt_id: z.string().min(1).max(200).describe("Stable execution/test-run identity, shared by all observers of the SAME attempt"),
  result: FeedbackResult,
  environment: Applicability,
  evidence: Observation.optional(),
  problem: z.string().max(240).optional(),
  signals: z.array(z.string().max(300)).max(8).optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;
export const Vote = FeedbackInput.omit({ id: true })
  .extend({ recorded_at: z.string().datetime() })
  .superRefine((vote, ctx) => {
    if (vote.result.startsWith("verified-") && (!vote.evidence || vote.evidence.level === "reported"))
      ctx.addIssue({ code: "custom", message: "verification votes require test or target-environment evidence" });
  });
export const Lifecycle = z.enum(["active", "needs-review", "disputed", "superseded"]);

/** Fields the agent supplies when recording. Everything else is derived deterministically. */
export const ExperienceInput = z.object({
  problem: z.string().min(3).max(240).describe("One-line statement of the problem, as generic as is accurate"),
  signals: z
    .array(z.string().min(1).max(300))
    .max(8)
    .default([])
    .describe("Exact error messages, failing commands, or symptoms. These form the deterministic fingerprint."),
  context: z
    .array(z.string().min(1).max(40))
    .max(10)
    .default([])
    .describe("Tags: language, framework, tool, OS, domain. e.g. ['node','postgres','macos']"),
  attempts: z.array(Attempt).max(12).default([]).describe("Ordered list of what was tried and whether it worked"),
  fix: z.string().max(600).default("").describe("What finally worked, concrete enough to repeat. Empty if unresolved."),
  avoid: z.array(z.string().min(1).max(200)).max(8).default([]).describe("Things that did not work or made it worse"),
  root_cause: z.string().max(300).optional().describe("Why the problem happened, if known"),
  outcome: Outcome.describe("Overall result"),
  kind: Kind.default("episode").describe("'episode' = one concrete experience; 'rule' = a generalisation distilled from several"),
  source: Source.optional(),
  applicability: Applicability.optional(),
  preconditions: z.array(z.string().min(1).max(200)).max(8).optional(),
  claims: z.array(Claim).max(12).optional(),
  observations: z.array(Observation).max(30).optional(),
});
export type ExperienceInput = z.infer<typeof ExperienceInput>;

/** The full stored record. */
export const Experience = ExperienceInput.extend({
  id: z.string(),
  v: z.literal(SCHEMA_VERSION),
  fingerprint: z.string(),
  related: z.array(z.string()).default([]).describe("Ids of records with the same fingerprint but a different fix"),
  dismissed_for: z.array(z.string()).default([]).describe("Query keys this record must not be recalled for again (false positives)"),
  stats: Stats,
  created: z.string(),
  updated: z.string(),
  // Optional extensions keep v1 catalogues readable without inventing evidence.
  votes: z.array(Vote).optional(),
  lifecycle: Lifecycle.optional(),
  superseded_by: z.string().optional(),
  family: z.string().optional(),
  history: z
    .array(
      z.object({
        revision: z.string(),
        at: z.string(),
        reason: z.string(),
        input: ExperienceInput,
        lifecycle: Lifecycle.optional(),
        superseded_by: z.string().optional(),
        family: z.string().optional(),
      }),
    )
    .optional(),
  reviews: z
    .array(
      z.object({
        key: z.string(),
        at: z.string(),
        action: z.string(),
        winner_id: z.string().optional(),
        feedback_count: z.number().int().nonnegative().optional(),
        evidence: Observation,
      }),
    )
    .optional(),
});
export type Experience = z.infer<typeof Experience>;

/** Bayesian success rate: (successes + 1) / (uses + 2). New records sit at 0.5. */
export function confidence(stats: Stats): number {
  return (stats.successes + 1) / (stats.uses + 2);
}

/**
 * Damping applied to fuzzy (non-exact) matches of a record that keeps surfacing where it does not belong.
 * 0 dismissals -> 1.0, 1 -> 0.8, 2 -> 0.67, 4 -> 0.5. Exact matches are never damped.
 */
export function relevance(stats: Stats): number {
  return 1 / (1 + 0.25 * stats.dismissed);
}

/** Terse shape returned by recall. Optimised for tokens, not for completeness. */
export interface RecallHit {
  id: string;
  kind: Kind;
  problem: string;
  fix: string;
  avoid: string[];
  root_cause?: string;
  context: string[];
  outcome: Outcome;
  confidence: number;
  uses: number;
  revision?: string;
  applicability?: "match" | "unknown" | "mismatch";
  constraints?: Applicability;
  preconditions?: string[];
  lifecycle?: string;
  recommendation?: "diagnostic-lead" | "check-before-use" | "candidate-fix" | "historical";
  evidence?: {
    successes: number;
    failures: number;
    diagnostic_helps: number;
    last_verified: string | null;
    level: string;
    confidence: number;
    basis: string;
  };
  match: {
    score: number;
    exact: boolean;
    via: Array<"fingerprint" | "semantic" | "lexical">;
  };
}

export function toRecallHit(e: Experience, match: RecallHit["match"]): RecallHit {
  const hit: RecallHit = {
    id: e.id,
    kind: e.kind,
    problem: e.problem,
    fix: e.fix,
    avoid: e.avoid,
    context: e.context,
    outcome: e.outcome,
    confidence: round(confidence(e.stats)),
    uses: e.stats.uses,
    match: { ...match, score: round(match.score) },
  };
  if (e.root_cause) hit.root_cause = e.root_cause;
  return hit;
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
