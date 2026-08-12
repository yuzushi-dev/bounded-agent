# bounded-agent

A user-scoped runtime and CLI for executing declared local workers.

A run defines the task, acceptance check, writable paths, and resource limits. The worker runs without network access in a bubblewrap sandbox. Failed or interrupted runs roll back to the recorded baseline. Receipts record the result.

## Requirements

- Node.js 22.22 or newer, within Node 22
- Linux, bubblewrap, and a systemd user session for hard containment and recovery
- macOS is supported with advisory guard behavior only

## Repository

The public package is assembled from `packages/bounded-agent/`.

Run the tests from the repository root:

```sh
npm test
```

Inspect the package payload without publishing it:

```sh
node packages/bounded-agent/assemble.mjs /tmp/bounded-agent
(cd /tmp/bounded-agent && npm pack --dry-run --json --ignore-scripts)
```

## License

MIT
