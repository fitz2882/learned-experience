# Learned Experience 0.4.0 verification

Verified locally on 2026-09-09 before publication. The checks below used isolated catalogues; publication and host activation are verified separately in the GitHub release notes.

## Delivered behavior

- Revision-bound verification reports, shared execution identities and atomic duplicate-vote prevention across catalogue connections.
- Separate solution verification, diagnostic usefulness, relevance and legacy reported outcomes.
- Applicability checks, visible preconditions, conservative abstention and reviewed duplicate families.
- Preserved snapshots, evidence-backed correction/supersession, guarded amendments and explicit restoration.
- A local five-minute maintenance worker, persistent cursor/queue, prioritized review items and bounded host-agent review instructions.
- Backward-compatible MCP tools and v1 catalogue reading, with vote/history-aware JSONL portability.

## Results

| Check | Result |
|---|---|
| TypeScript check and build | Pass |
| Unit/integration suite | 118 tests across 10 files pass |
| Built-server quality replay | 11 checks pass over real MCP stdio and local MiniLM embeddings |
| Retrieval regression subset | 3 positive queries return their expected lesson; 3 unrelated queries return no results |
| Installed-artifact shape | npm package includes the new learning, maintenance and worker runtime modules |
| Packaged runtime | Same 11-check replay passes with both workspace dependencies and a fresh consumer install of the release tarball |
| Codex hooks | PostToolUse/UserPromptSubmit output validates against committed host schema fixtures; Stop emits no output |
| Catalogue replay | Isolated test copy loads with all embeddings and no embedding error; relevant matches are retained and an unrelated match is excluded |
| Duplicate detection and grouping | A duplicate pair is automatically identified for review; reviewed grouping yields one recall slot while retaining both records |
| Whitespace/diff integrity | Pass |

Replay checks used an isolated catalogue copy that is not included in this repository. Test records were confined to isolated test catalogues.

## Generate / verify / revise review

GVR-GENERATE COMPLETE: assumes cooperative MCP hosts supply honest execution identities, source/test evidence and exact version constraints. Checks considered repeated observations, changed content, unrelated queries, stale imports, concurrent connections, and superseded records.

Executable verification caught bookkeeping fields leaking into revision identities and redundant history growth; both were corrected. Subsequent review caught restoration retaining later optional scope fields and a queued candidate being able to reactivate superseded content; both now have regressions. The revised suite and real runtime replay pass.

Dismissed concerns: an old positive report is not silently promoted because legacy counters and verified votes are separate; one shared test does not accumulate duplicate votes because identity checks run under a SQLite write transaction; semantic maintenance does not execute stored prose because its worker only compares data and queues proposals.

GVR-VERIFY: PASS for the implemented scope after revisions; no known blocking test failures remain.

## Practical limits

- Verification is reported by agents, not cryptographic proof of independent runs or causal success. Genuine execution identities and checked evidence are still required.
- Deterministic detection runs automatically while an MCP server or standalone worker is running. Semantic corrections require an active cooperating host agent with evidence; unresolved jobs remain queued. No external reviewer or new cloud costs were introduced.
- Exact scope/version checks are supported. Automatic filesystem artifact-drift watchers and host-attested execution receipts are not implemented.
- The six retrieval queries are regression checks, not a general accuracy benchmark. Desktop final-answer rendering was not independently observed.
- A fresh install of the release tarball and registry-resolved dependencies also passes all 11 runtime checks. This is a runtime compatibility check, not a new dependency-security claim.
- Marketplace launch commands pin the runtime to 0.4.0. Existing installations require a marketplace update and host restart. Upgrade all writers together after a backup; older binaries may strip fields they do not understand.

Reproduce with `npm run typecheck`, `npm test`, and `npm run quality`. See README.md for the maintenance and verification workflow.
