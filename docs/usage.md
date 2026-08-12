# Usage

Start OMP after installation. Check the independent guard before a run:

```text
/bounded doctor
/bounded status
```

A run requires every operator-controlled field and an interactive confirmation:

```text
/bounded run --task "Update the approval page" --acceptance "tests pass" --scope approval-console/index.html,approval-console/test_index.py --max-seconds 300 --max-read-bytes 4096 --max-artifact-bytes 2048 --max-output-bytes 1024 --max-requests 2 --prohibited-effects "all external effects" --final-gate human-approval
```

OMP shows the exact request and digest. Confirm only if the task, acceptance check, writable paths, budgets, prohibited effects, and final gate are correct. A changed scope requires a new contract.

Other commands:

```text
/bounded rollback
/bounded doctor
/bounded status
```

`rollback` cancels an active run and verifies protected L3. `doctor` checks installation, qualification, controller, and guard health. `status` reconciles interrupted work and reports the effective level and deadline.

OMP is the enforcement host: its extension intercepts OMP lifecycle and tool events and calls the controller directly. The bundled skill is guidance only. Codex and Claude may consume compatible guidance or future adapters, but this release does not claim equivalent interception or enforcement in those hosts.

Headless clients can drive the same slash command and confirmation through OMP's [official JSONL RPC protocol](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md). OMP's distinction between extensions, tools, hooks, and skills is documented in [Custom Tools](https://github.com/can1357/oh-my-pi/blob/main/docs/custom-tools.md).
