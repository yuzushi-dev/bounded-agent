# Bounded runtime

`plugins/bounded/` is self-contained. It does not import or require the historical `omp-bounded` tree, its process, or its environment.

The runtime owns the contract digest, client/session identity, state machine, journal, lease, worker, verifier, receipt, delivery, and rollback. The Codex CLI and hooks are adapters only. Communication is local-only versioned JSONL over a private Unix socket.

## Guarantees

- worker argv is spawned without a shell;
- bubblewrap creates a network-disabled process/filesystem boundary;
- only contract-declared read paths are mounted from the project;
- only declared output files are writable and delivered;
- deadline and stdout/stderr budgets terminate the worker;
- failed, expired, unverifiable, or interrupted runs roll back by default;
- an explicit `preserve-for-review` policy restores the live baseline but retains validated declared artifacts in a private quarantine for operator review;
- receipts bind contract, run, client/session, lease, counters, artifacts, and terminal result;
- the runtime remains alive when a client disconnects;
- the external systemd user guard can reconcile a stale lease after runtime death.

The acceptance text is never executed as a shell command. The runtime supports deterministic `<declared-output> contains <literal>` and `<declared-output> equals <literal>` assertions against the staged artifact. The operator reference is metadata only; an unsupported or false assertion rolls back unless the contract explicitly selected `preserve-for-review`. Preserved artifacts are not delivered; applying them is an explicit operator action.

## Limits

Linux, Node.js 22, bubblewrap, and systemd user services are supported-host prerequisites. Same-UID processes can tamper with user-owned state, so this is not a multi-tenant or kernel security boundary. Existing exec sessions, hosted tools, and hook opt-outs are not retroactively sandboxed. Hooks can deny the supported adapter seam, but they cannot prove or contain arbitrary host execution.

The repository root remains historical/reference material. Publishing, pushing, deploying, persistent installation, and marketplace registration are separate gated actions.
