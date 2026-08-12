# bounded-agent

`bounded-agent` packages the standalone `bounded` runtime and CLI for explicit local agent workflows.

## Quick start

```sh
npx bounded-agent install --dry-run
npx bounded-agent install
bounded-agent doctor
```

The installer is user-scoped. It creates versioned runtime files under the user data directory, a private state directory, and a stable `bounded-agent` launcher. Use `--runtime-only` for the core runtime or select a native host adapter explicitly with `--adapter <name>`.

Runtime prerequisites are Node.js 22.22 or newer within the Node 22 line. Linux worker containment requires bubblewrap and a working systemd user session. On macOS and other non-Linux hosts the guard is advisory; this package makes no kernel or process-containment claim there.

The runtime is the authority for contracts, budgets, worker execution, state recovery, receipts, and rollback. Native adapters are optional host integrations and are not required by the core runtime.

Licensed under the MIT License.
