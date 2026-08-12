# Preserve-for-Review Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement the plan task-by-task.

**Goal:** Let an operator opt into retaining safe bounded output after failure without publishing it into the project.

**Architecture:** Extend the signed runtime contract with `stopPolicy.onFailure = preserve-for-review`. On failure, the controller restores the live baseline, validates only declared regular artifacts, moves them to a private per-run quarantine, and records a `preserved` receipt. The existing rollback path remains the default and the guard uses the same policy after runtime, worker, lease, or deadline failure.

**Tech Stack:** Node.js ESM, versioned JSONL runtime protocol, atomic state/receipts, node:test, bubblewrap.

---

### Task 1: Contract and lifecycle policy

**Files:**
- Modify: `plugins/bounded/runtime/src/contract.mjs`
- Modify: `plugins/bounded/runtime/src/state.mjs`
- Modify: `plugins/bounded/runtime/src/receipt.mjs`
- Test: `tests/runtime/contract.test.mjs`
- Test: `tests/runtime/state.test.mjs`
- Test: `tests/runtime/receipt.test.mjs`

Write failing tests for the explicit policy and `preserved` terminal result, then implement the smallest schema/lifecycle extension. Unknown policies remain invalid.

### Task 2: Quarantine failed artifacts

**Files:**
- Modify: `plugins/bounded/runtime/src/controller.mjs`
- Test: `tests/runtime/controller.test.mjs`

Write failing tests for worker failure and runtime death under `preserve-for-review`. Assert live baseline restoration, declared artifact retention under `stateRoot/preserved/<runId>`, valid receipt, no lease, and rejection of undeclared/symlinked quarantine content. Implement policy-directed failure handling and status exposure.

### Task 3: CLI and documentation

**Files:**
- Modify: `plugins/bounded/bin/bounded.mjs`
- Modify: `plugins/bounded/README.md`
- Modify: `docs/bounded-plugin.md`
- Modify: `plugins/bounded/skills/bounded-autonomy/SKILL.md`
- Test: `tests/codex/*.test.mjs` or a focused CLI test

Expose `--on-failure preserve-for-review` for planning, document the default and quarantine path, and state that applying preserved files remains an explicit operator action.

### Task 4: Verify

Run the focused runtime tests, then `npm test`, plugin validation, syntax checks, and `git diff --check`. Do not change the installed systemd unit; it already points to the runtime path and will pick up the updated runtime after its process restarts.

## Implementation checkpoint — 2026-08-12

Implemented and verified. `preserve-for-review` is opt-in; rollback remains the default. Failed runs restore the live baseline, retain only declared regular artifacts under `stateRoot/preserved/<runId>`, publish a valid `preserved` receipt, remove the lease, and expose the quarantine path through `status`. Explicit operator rollback still forces rollback.

The persistent runtime was restarted on the new code. A real state-root fixture passed through the installed runtime: worker failure produced `preserved`, a valid receipt, and the expected `draft` artifact; the fixture was then removed. Focused tests, full `npm test`, plugin validation, syntax checks, and diff checks pass.
