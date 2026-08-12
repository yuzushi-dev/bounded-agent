---
name: bounded-autonomy
description: Use for local work that needs an explicit scope, worker, deadline, budget, and human finish gate.
---

# Bounded autonomy

Use the installed `bounded` CLI for work that can be expressed as a declared worker argv and local output set.

1. Define the task, acceptance check, relative read/write paths, worker command/args, deadline, byte budgets, and `all external effects` prohibition.
2. Run `bounded doctor`, then `bounded plan`; show the full contract and digest to the operator.
3. From an external terminal, run `bounded approve` and `bounded activate` using the same state root. Activation fails closed on digest, identity, lease, or host-readiness drift.
4. The runtime owns the worker. It clears ambient environment, disables network, mounts only declared paths, enforces hard deadline/output limits, stages outputs, and keeps running after the client disconnects.
5. Use a runtime-owned acceptance assertion (`<declared-output> contains <literal>` or `equals`). Run `bounded complete --result accepted --acceptance-ref ...` only after the staged artifact satisfies it, or run `bounded rollback`. Failed, expired, unsupported, and interrupted runs roll back by default; opt into `--on-failure preserve-for-review` to retain validated declared artifacts in quarantine for manual review without delivering them.

Host hooks are adapter guardrails. They do not sandbox arbitrary shell tools, hosted tools, existing execution sessions, or hook opt-outs. Same-UID state tampering is outside the trust boundary.
