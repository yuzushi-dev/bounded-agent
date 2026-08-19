# bounded-agent

`bounded-agent` is a standalone bounded execution runtime and CLI for Claude, Codex, and local agent workflows. It combines a shared execution protocol with host adapters, scope enforcement, rollback, and proportional verification.

## Quick start

```sh
npx bounded-agent install --dry-run
npx bounded-agent install
bounded-agent doctor
```

Create a protocol before execution:

```sh
bounded-agent prepare \
  --task "Fix parser regression" \
  --scope "src/parser.mjs,tests/parser.test.mjs" \
  --acceptance "malformed input returns E_PARSE,affected tests stay green" \
  --output /tmp/bounded-protocol.json
```

The protocol selects a task-specific evidence strategy and one of four assurance levels: direct, verified, planned, or orchestrated. Normal maintenance uses the current agent plus at most one fresh verifier. Multi-agent fan-out is reserved for genuinely disjoint or high-risk work.

A resolved protocol becomes an enforced runtime contract through `bounded-agent plan-protocol`. `bounded-agent verifier-brief` creates the independent verification contract and `bounded-agent verify-result` rejects incomplete PASS claims.

The installer is user-scoped. It creates versioned runtime files under the user data directory, a private state directory, and a stable `bounded-agent` launcher. Use `--runtime-only` for the core runtime or select a native host adapter explicitly with `--adapter <name>`.

Runtime prerequisites are Node.js 22.22 or newer within the Node 22 line. Linux worker containment requires bubblewrap and a working systemd user session. On macOS and other non-Linux hosts the guard is advisory; this package makes no kernel or process-containment claim there.

The runtime is the authority for contracts, budgets, worker execution, state recovery, receipts, and rollback. Native adapters map the shared protocol onto host controls. External Git operations, deployment, spending, destructive remote actions, credential use, and third-party communication remain behind a separate human decision.

Licensed under the MIT License.
