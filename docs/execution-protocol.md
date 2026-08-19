# Bounded Execution Protocol

Bounded uses one shared contract for Claude and Codex and keeps host-specific enforcement in adapters. The protocol is designed to spend model calls only on judgment: semantic clarification, implementation, and independent verification when the risk warrants it. Deterministic classification, state, budgets, validation, receipts, and rollback stay in code.

## Flow

```text
user task
  -> repository inspection
  -> protocol contract
  -> ask user only for unresolved semantic forks
  -> bounded execution
  -> evidence strategy
  -> fresh verification when required
  -> runtime acceptance
  -> human gate for external effects
```

`bounded prepare` produces the protocol object. It infers a task strategy and one of four assurance levels.

| Level | Use | Agent budget |
|---|---|---|
| L0 direct | trivial narrow reversible work | no subagent |
| L1 verified | normal maintenance and bugfix work | one fresh verifier |
| L2 planned | migrations, refactors, breaking or ambiguous work | main agent plans; one fresh verifier |
| L3 orchestrated | high-risk or genuinely disjoint multi-surface work | disjoint workers plus one final verifier |

L3 does not authorize automatic fan-out. A worker is justified only when it owns a disjoint implementation surface. A verifier is justified because it produces independent evidence. Planner, coordinator, scribe, relay, and review-of-review agents are excluded from the default design.

## Contract generation

```sh
bounded prepare \
  --task "Fix refresh-token timeout regression" \
  --scope "src/auth/refresh.ts,tests/auth/refresh.test.ts" \
  --acceptance "expired token returns documented error,affected auth tests stay green" \
  --output /tmp/bounded-protocol.json
```

The resulting protocol contains task, strategy, assurance, read/write scope, acceptance IDs, evidence requirements, unresolved decisions, effects, limits, lanes, and a human publication gate.

When an unresolved decision changes behavior, architecture, compatibility, persisted data, or user-visible semantics, pass it to `--unresolved`. `plan-protocol` refuses to execute until the decision is resolved.

## Evidence strategies

The protocol selects evidence by work type instead of imposing universal TDD or a fixed coverage percentage.

- Bugfix: reproduce before when feasible, regression test, affected tests, scope check.
- Migration: before/after invariants, migration test, affected tests, scope check.
- Dependency update: build/typecheck, compatibility check, affected tests, scope check.
- Refactor: behavior preservation, affected tests, scope check.
- Config: validation and smoke test.
- Feature: behavior test, affected tests, unhappy-path check, scope check.

Changed behavior must be exercised. Existing affected behavior must not regress.

## Runtime translation

A resolved protocol can be translated into the existing enforced runtime contract:

```sh
bounded plan-protocol \
  --protocol /tmp/bounded-protocol.json \
  --cwd "$PWD" \
  --worker-command <worker> \
  --worker-args-json '<argv-json>' \
  --output /tmp/bounded-runtime-contract.json
```

The existing approve, activate, status, complete, and rollback lifecycle remains authoritative. Sandbox, deadline, write scope, protected baseline, recovery, and external-effect restrictions remain runtime concerns rather than LLM instructions.

## Fresh verification

For L1-L3, the host creates one fresh verifier after implementation unless the task carries a concrete reason for another specialty review.

```sh
bounded verifier-brief \
  --protocol /tmp/bounded-protocol.json \
  --diff-summary "$(git diff --stat)" \
  --test-evidence "<captured test output>"
```

The verifier checks repository reality and returns a JSON result with one status per acceptance ID. It must not consume implementation success reasoning. `bounded verify-result` rejects incomplete PASS claims:

```sh
bounded verify-result \
  --protocol /tmp/bounded-protocol.json \
  --result-file /tmp/bounded-verifier-result.json
```

## Claude and Codex

Both hosts consume the same protocol and runtime commands.

Claude's adapter adds hooks that block host-side external effects while a bounded run is active and includes a dedicated `bounded-verifier` agent definition for fresh verification.

Codex consumes the packaged `bounded-autonomy` skill. The skill keeps planning and integration in the main context, uses fresh subagent verification only for L1-L3, and relies on the bounded runtime plus Codex's host controls instead of adding a second orchestration hierarchy.

## Authority boundary

No protocol authorizes remote Git operations, deployment, spending, deletion of user data, credential use, or third-party communication. These remain separate human-authorized actions after local verification.
