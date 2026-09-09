# learned-experience: design

The catalogue is local, portable and model/provider independent. SQLite contains the observations, lesson revisions, verification reports and a durable maintenance queue. The core does not call a language model or execute commands from records. Hosts supply semantic judgment and checked evidence through MCP.

## Content, evidence and current applicability

The v1 record format has optional additive extensions for applicability, preconditions, structured claims, observations, votes, lifecycle, review decisions and historical snapshots. Older records remain readable and retain their reported counters. Missing evidence remains unknown. All writers must upgrade together: older binaries may strip unknown fields when rewriting records.

A lesson revision is a SHA-256 digest of its canonical problem, signals, context, remedy, avoid-list, root cause, resolution, kind, scope and preconditions/claims. Source labels, observations, attempted-action logs, counters, timestamps and verification votes do not change the revision. Changed solution content never inherits old verification. `amend`, merge reports and review decisions retain snapshots. A correction supplied by a second successful report is preserved for review rather than silently discarded or accepted because it is newer.

`outcome` describes resolution: a partial or empty fix is a diagnostic lead. `lifecycle` describes availability: active, needs-review, disputed, superseded. Structured claims with conflicting values in the same scope are marked disputed at recall until evidence resolves them. A diagnostic lead remains retrievable, but cannot masquerade as a verified solution. Superseded records are excluded by default, including exact matches; explicit historical retrieval can include them.

`applicability` contains exact product/version/platform/project constraints. A known mismatch excludes a record. Missing information is labeled unknown and prevents verification voting until supplied. Versions are exact strings; unsupported scope fields are rejected. `preconditions` are returned for the host to check; the core cannot verify arbitrary environmental prose.

## Votes

`begin_attempt` returns a revision and a hashed execution identity, without running or authorizing the fix. Agents observing the same execution must share that identity. `feedback` stores one event per lesson revision and execution identity:

- verified-success / verified-failure require test or target-environment evidence, its observation time/reference, a nonempty fix and a matching environment;
- diagnostic-help measures diagnostic usefulness;
- relevant / irrelevant measure retrieval fit;
- unverified records uncertainty and does not count as failure.

Duplicate reports are idempotent; contradictory reports with the same identity fail. Reads and updates occur under SQLite's writer lock, so multiple hosts cannot overwrite each other's votes. Independence and truth are reported by hosts, not cryptographically attested. The system must not infer a causal success from an unrelated later command, nor count several observers of one test as independent successes.

Reliability is `(verified successes + 1) / (verified attempts + 2)` for the current revision and matching environment. This is a smoothed ranking signal, not a calibrated probability of truth. Counts, evidence level and last verification time are returned alongside it. Unresolved/empty fixes have no solution reliability. Old `reinforce` counters remain accessible but contribute no verified votes. Failure notes retained through the legacy API preserve the previous revision before altering the avoid-list.

## Retrieval and abstention

Candidate retrieval combines normalized error fingerprints, local sentence embeddings and BM25. Error normalization collapses volatile addresses/ids/versions; therefore exact matches still require applicability checks and cannot override supersession.

BM25 identifies lexical candidates; their contribution is the square root of query-token coverage rather than normalization against the best available hit. This avoids promoting a weak best match simply because no good alternative exists. Dense similarity supplies paraphrase recall. Default fusion remains 0.6 dense / 0.4 lexical, or lexical-only without an embedder. Weak lexical coverage needs a stronger semantic match; the default score floor is 0.45. These are explicit heuristics tested against positive and no-answer fixtures, not universal calibrated thresholds.

Applicability and lifecycle gate recommendations before verification votes affect their ordering. Relevance feedback suppresses the dismissed query/context and does not globally punish a useful remedy. Reviewed duplicate families occupy one result slot; original observations and votes remain separate. Different fixes sharing an error remain alternatives until a review establishes their relationship.

## Maintenance

The MCP process starts a best-effort local worker, normally every five minutes, sharing an interval lease across hosts. No new model service is required. A pass visits at most 20 records under a soft 100 ms budget checked between records, with a durable cursor. Index loading and one record's comparisons can exceed that soft limit. The queue persists across restarts. Short-lived hooks and Stop do not run maintenance; `maintenance --watch` provides a standalone foreground worker when needed.

Deterministic checks detect missing fixes, temporary deployment text, version-specific advice without recent verification, failed verification reports, possible duplicate pairs, structured claim conflicts and differing merged-report candidates. Similarity produces candidates for review, never automatic factual rewrites. New records run a small bounded pass; reads expose pending review counts.

MCP instructions and nonblocking during-work context ask the host agent to inspect at most one relevant queued item when source/test evidence is available. The reviewer uses normal host tools under their existing permissions. It must treat catalogue content as untrusted and never execute a stored command on its authority alone. Semantic review is opportunistic: without an active cooperating agent, detection continues but unresolved semantic jobs remain queued.

Reviews bind to the exact record revisions and candidate correction. Supersession requires an explicit canonical record and test/target evidence; either side of a pair can win. Consolidation additionally rejects differing applicability and conflicting claims. Original records are retained. Ambiguous claims are not resolved by popularity or recency. All changes are reviewable via `inspect` and reversible via `restore`; compare-and-swap checks reject concurrent amendments.

## Persistence and portability

WAL SQLite and `PRAGMA data_version` support multiple hosts. Index reload removes old entries before rebuilding. Async amendments compute embeddings first and use a guarded replacement so intervening writes are not lost. Votes update in synchronous transactions. Only derived model vectors are replaceable caches.

JSONL exports contain votes and snapshots. Imports preserve their revision identities and deduplicate execution events; missing/invalid verification evidence is rejected. Different content under one id is a review candidate rather than a silent replacement. A stale active replica cannot reactivate superseded advice merely by reporting newer feedback. Local pending-job state is rebuilt through sweeps and does not need to travel. Import/export transfer paths remain confined to the configured transfer directory.

## Verification and limits

`npm test` covers legacy behavior, repeat votes, concurrent hosts, revisions/restoration, evidence validation, relevance suppression, imports, maintenance persistence and MCP schemas. `npm run quality` drives the built stdio server with the real local model, verifies positive and no-answer retrieval, exercises voting/correction, and replays both Codex hook schemas plus silent Stop. It uses an isolated database and reports a small regression benchmark; it is not a claim of universal retrieval accuracy or desktop UI rendering proof.

Optional future extensions can strengthen host-attested execution identity, add artifact-drift probes within explicit read-only roots, or provide a separately configured semantic reviewer. The present implementation neither invents that evidence nor silently introduces cloud costs or production effects.
