# bounded-agent

A user-scoped runtime and CLI for executing declared local workers with explicit scope, limits, sandboxing, and rollback.

## Install

Install the published package:

```sh
npx bounded-agent@latest install
```

The installer is user-scoped. It supports Linux and macOS with Node.js 22.22+. Linux hard containment requires bubblewrap and a systemd user session. macOS guard behavior is advisory.

Remove the installation with:

```sh
bounded-agent uninstall
```

## Use

Check the installation:

```sh
bounded-agent doctor
```

Install only the runtime:

```sh
bounded-agent install --runtime-only
```

Select adapters explicitly with repeated `--adapter` flags:

```sh
bounded-agent install --adapter agent-plugins --adapter codex --adapter claude
```

Use the runtime through `plan`, `approve`, `activate`, `status`, `complete`, and `rollback`.

## Safety

- Runs declare the task, acceptance check, writable paths, and resource limits.
- Linux workers run without network access in bubblewrap.
- Failed or interrupted runs roll back to the recorded baseline.
- Receipts record state and results.
- The trust boundary is same-UID. This is not multi-user or kernel isolation.
- macOS has advisory guard behavior only.

## Development

The public package is assembled from `packages/bounded-agent/`.

```sh
npm test
npm run test:package
node packages/bounded-agent/assemble.mjs /tmp/bounded-agent
(cd /tmp/bounded-agent && npm pack --dry-run)
```

## License

MIT
