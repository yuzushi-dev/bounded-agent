---
name: bounded-autonomy
description: Use when local coding work benefits from an explicit execution contract, bounded authority, proportional planning, evidence, rollback, and independent verification when warranted.
---

# Bounded Execution Protocol

Use bounded for local coding work that needs a clear outcome and controlled authority. Keep read-only questions outside bounded execution.

Follow `clarify real forks -> contract -> execute -> verify -> human external-effect gate`.

Inspect the repository first. Infer the smallest credible writable scope and concrete acceptance criteria. Resolve technical details from repository evidence. Ask the human only when two or more valid choices would change behavior, architecture, compatibility, persisted data, or user-visible semantics.

Create the protocol with `bounded prepare --task <task> --scope <paths> --acceptance <criteria> --output <file>`. The protocol selects an evidence strategy and an assurance level:

- L0 direct: trivial narrow reversible work; no subagent.
- L1 verified: normal maintenance; current agent executes, one fresh verifier checks the result.
- L2 planned: migration, refactor, breaking or ambiguous work; current agent plans and executes, one fresh verifier checks the result.
- L3 orchestrated: high-risk or genuinely disjoint multi-surface work; parallelize only lanes with exclusive ownership, then use one fresh final verifier.

Never spawn an agent for bookkeeping, context relay, plan rewriting, logging, coordination without disjoint work, or review-of-review. Every subagent must own disjoint implementation work or produce independent evidence.

Use strategy-specific evidence. Bugfixes need reproduction when feasible, regression coverage and affected tests. Migrations need before/after invariants and migration tests. Dependency updates need build/type checks, compatibility checks and affected tests. Refactors need behavior-preservation tests. Config changes need validation and smoke tests. New behavior needs behavior and unhappy-path checks. Do not impose a fixed coverage percentage unless the task requires one.

A protocol containing unresolved decisions cannot execute. A resolved protocol becomes an enforced runtime contract through `bounded plan-protocol`. The existing approve, activate, complete and rollback lifecycle remains authoritative for sandboxing, deadlines, write scope, recovery and protected-baseline restoration.

For L1-L3, build a fresh verifier brief with `bounded verifier-brief`. The verifier must inspect repository reality without trusting the implementer's success reasoning. Validate its JSON result with `bounded verify-result`; PASS requires every acceptance criterion to pass and no open findings.

No bounded run authorizes remote Git operations, deployment, spending, deletion of user data, credential use, or third-party communication. Those actions require a separate human decision after local verification.
