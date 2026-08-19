---
name: bounded-autonomy
description: Use for bounded local coding work that needs scope control, proportional planning, execution evidence, independent verification when warranted, rollback, and a human publication gate.
---

# Bounded execution protocol

Use bounded as a proportional execution protocol, not as a mandatory multi-agent workflow.

## Operating rule

Use this sequence:

`clarify only real forks -> build contract -> execute inside bounds -> verify to the selected assurance level -> require human approval for external effects`

Do not spend model calls on deterministic bookkeeping. Do not spawn agents to summarize context already available, rewrite a plan, relay files, record state, review another review, or choose obvious tooling.

## 1. Build the contract

Inspect the repository first. Infer the smallest credible write scope and explicit acceptance criteria from the user's task and repository evidence.

Identify unresolved decisions before execution. Resolve them from repository evidence when possible. Ask the user only when multiple materially different valid outcomes remain and the choice changes behavior, architecture, compatibility, persisted data, or user-visible semantics. Put such decisions in `--unresolved`; `bounded prepare` will mark the protocol as blocked until they are resolved.

Create the protocol with `bounded prepare`. Example:

```sh
bounded prepare \
  --task "Fix refresh-token timeout regression" \
  --scope "src/auth/refresh.ts,tests/auth/refresh.test.ts" \
  --acceptance "expired refresh tokens return the documented error,affected auth tests stay green" \
  --output /tmp/bounded-protocol.json
```

The runtime chooses an evidence strategy and an assurance level unless there is a concrete reason to override them.

- L0 direct: trivial, narrow, reversible work. No subagent.
- L1 verified: normal maintenance. Main agent executes; one fresh verifier checks the result.
- L2 planned: migrations, refactors, breaking changes, or unresolved design work. Main agent writes the plan and executes it; one fresh verifier checks the result.
- L3 orchestrated: high-risk or genuinely disjoint multi-surface work. Parallelize only lanes with disjoint ownership. Use one final fresh verifier after integration.

Never add agents merely to fill capacity. An agent must either own disjoint implementation work or provide independent evidence.

## 2. Evidence strategy

Use the protocol's selected strategy rather than universal TDD:

- bugfix: reproduce before when feasible, regression test, affected tests, scope check;
- migration: before/after invariants, migration test, affected tests, scope check;
- dependency update: build/typecheck, compatibility check, affected tests, scope check;
- refactor: behavior-preservation tests, affected tests, scope check;
- config: config validation and smoke test;
- new behavior: behavior test, affected tests, unhappy path, scope check.

Do not invent a fixed coverage percentage. New or changed behavior must be exercised and touched code must not regress.

## 3. Activate bounded execution

When the protocol has no unresolved decisions, translate it into the enforced runtime contract:

```sh
bounded plan-protocol \
  --protocol /tmp/bounded-protocol.json \
  --cwd "$PWD" \
  --worker-command <host-worker-command> \
  --worker-args-json '<host worker argv json>' \
  --output /tmp/bounded-runtime-contract.json
```

Run `bounded doctor` first. Approval and activation remain external lifecycle operations. Do not bypass the runtime's sandbox, deadline, rollback, external-effect prohibition, or protected baseline.

## 4. Execute with the minimum agent budget

The main agent owns planning, synthesis, integration, and final presentation. The main model always inherits the user's active Codex model and effort.

For Codex subagents, use these defaults:

- L1 verifier: `gpt-5.6-luna` with `xhigh` reasoning (`bounded-fast`);
- L2 verifier: `gpt-5.6-luna` with `xhigh` reasoning (`bounded-standard`);
- L3 disjoint worker: `gpt-5.6-luna` with `medium` reasoning (`bounded-standard-worker`);
- L3 final verifier: `gpt-5.6-sol` with `medium` reasoning (`bounded-strong`).

The worker profile is role-specific: it uses `workspace-write` and a lower reasoning effort than the semantic verifier. Treat model and effort as requested routing until the host exposes evidence of the effective launch. Do not claim a requested model was applied when the runtime cannot verify it.

For L0, execute and run the relevant check in the current context.

For L1 and L2, do not spawn a planner, coordinator, scribe, or reviewer fleet. Execute in the current context. After execution, create a fresh verifier brief with `bounded verifier-brief` and give that brief, the actual diff, repository state, and captured test/runtime evidence to one fresh verifier. The verifier must not consume the implementer's success reasoning.

For L3, split only real disjoint lanes. Each lane gets exclusive owned paths and declared dependencies. Parallel lanes must not edit the same files. Use `protocol.routing.worker` for each worker lane. After integration, use one fresh verifier from `protocol.routing.verifier` unless the risk itself requires another independent specialty review.

## 5. Verification and completion

The fresh verifier returns JSON matching the verifier brief: a `PASS|FAIL` verdict, one result for every acceptance id, and findings.

Save the result and validate it mechanically:

```sh
bounded verify-result \
  --protocol /tmp/bounded-protocol.json \
  --result-file /tmp/bounded-verifier-result.json
```

A PASS is valid only when every acceptance criterion is explicitly passed and findings are empty. A failure returns to the main execution context for repair; do not spawn a repair committee.

Use `bounded complete` only after the enforced runtime acceptance assertion also passes. Failure, expiry, interruption, or rejection rolls back by default.

## 6. Authority boundary

No bounded contract authorizes publishing, pushing, deployment, spending, deletion of user data, credential use, or third-party communication. Those actions require a separate human decision after local verification.

Host-native sandbox and approval mechanisms should enforce the same contract when they are stronger than a generic wrapper. Do not build a second sandbox merely to duplicate a stronger host boundary.
