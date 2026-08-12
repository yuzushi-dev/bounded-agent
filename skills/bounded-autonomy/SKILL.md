---
name: bounded-autonomy
description: Use when a multi-step local task has a narrow filesystem scope and must finish within explicit time and resource limits.
---

# Bounded Autonomy

Use bounded mode for multi-step local work when writable paths are narrow and execution must fit a short, explicit window. Keep single-step or read-only work outside bounded mode.

Build one `/bounded run` request with these operator fields:

- `--task`: exact outcome;
- `--acceptance`: deterministic runnable command and expected result;
- `--scope`: writable scope as explicit relative paths;
- `--max-seconds`: duration from 1 to 300 seconds;
- resource budget group: `--max-read-bytes`, `--max-artifact-bytes`, `--max-output-bytes`, and `--max-requests`;
- `--prohibited-effects "all external effects"`;
- `--final-gate human-approval`.

`--max-requests` is the controller-enforced worker and verifier request budget; set it to at least 2. `maxWorkers=1` is controller-fixed and is not an operator field.

Use this canonical shape:

```text
/bounded run --task "Update approval-console/index.html" --acceptance "node --test approval-console/test_index.test.mjs exits with code 0" --scope approval-console/index.html --max-seconds 300 --max-read-bytes 4096 --max-artifact-bytes 2048 --max-output-bytes 1024 --max-requests 2 --prohibited-effects "all external effects" --final-gate human-approval
```

The controller presents the exact preview; the human confirms it. The skill and model cannot confirm on the human's behalf. `/bounded` grants no permission and cannot bypass the controller. Let the controller reject unsafe paths, invalid budgets, stale state, or widened scope; start a new contract instead of weakening a rejected one.

External effect boundary: Do not invoke `/bounded` for an external effect. Never publish, push, deploy, send, purchase, delete remote data, use credentials, or contact third parties inside the run. Only prepare local artifacts, then stop for a separate human gate. Report the acceptance result; the final gate does not perform or authorize the external effect.
