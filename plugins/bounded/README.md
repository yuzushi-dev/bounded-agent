# Bounded

`bounded` packages a Codex adapter and an independent Linux runtime. The runtime is the authority for contracts, approval, leases, worker execution, sandboxing, state recovery, receipts, delivery, and rollback.

The plugin adapter only sends versioned JSONL requests over a private Unix socket and reports status. Hooks are context guardrails; they do not sandbox arbitrary Codex tools, hosted tools, existing exec sessions, or hook opt-outs.

Runtime prerequisites: Node.js 22, Linux, bubblewrap, and a systemd user session for the external recovery guard. The runtime clears the worker environment, disables network access, spawns explicit argv without a shell, exposes only declared read paths, binds only declared output files as writable, enforces deadline/output budgets, and rolls back failed or unverifiable work by default.

To keep failed work for inspection, add `--on-failure preserve-for-review` to `plan`. The runtime still restores the live project baseline, then retains only declared regular artifacts at `<state-root>/preserved/<run-id>`; `status` reports that path. Nothing is delivered automatically, and unsafe or undeclared residue falls back to rollback.

## Workflow

```text
node "$PLUGIN_ROOT/bin/bounded.mjs" doctor --state-root "$BOUNDED_STATE_ROOT"
node "$PLUGIN_ROOT/bin/bounded.mjs" plan --cwd "$PWD" \
  --task "produce the bounded artifact" \
  --acceptance "output.txt contains ok" \
  --scope output.txt --max-seconds 30 --max-read-bytes 4096 \
  --max-artifact-bytes 4096 --max-output-bytes 4096 --max-requests 2 \
  --prohibited-effects "all external effects" --final-gate human-approval \
  --worker-command /absolute/path/to/worker --worker-args-json '["--input","input.txt"]' \
  --output "$BOUNDED_STATE_ROOT/contract.json"
node "$PLUGIN_ROOT/bin/bounded.mjs" approve --contract "$BOUNDED_STATE_ROOT/contract.json"
node "$PLUGIN_ROOT/bin/bounded.mjs" activate --contract "$BOUNDED_STATE_ROOT/contract.json"
node "$PLUGIN_ROOT/bin/bounded.mjs" status --contract "$BOUNDED_STATE_ROOT/contract.json"
node "$PLUGIN_ROOT/bin/bounded.mjs" complete --contract "$BOUNDED_STATE_ROOT/contract.json" \
  --result accepted --acceptance-ref "external inspection passed"
```

`approve` and `activate` are explicit terminal operations. Client exit does not complete or cancel a run. Install the user guard from the runtime package and enable it separately; this handoff does not install or publish anything automatically.

The explicit installer is `bounded.mjs install-guard --config-home "$HOME/.config" --state-root "$BOUNDED_STATE_ROOT"`; it only writes the rendered user units. Enabling the timer remains an operator action.

The trust boundary is same-UID: a process with write access to the user state root can tamper with it. This is not multi-user or kernel isolation. Pre-existing processes, hosted execution, and hook opt-outs are outside the hard runtime boundary.
