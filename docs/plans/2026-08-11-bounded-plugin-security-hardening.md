# Bounded Plugin Security Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the release-blocking bypasses found by the Sol 5.6 medium audit while keeping `bounded` independent from historical `omp-bounded`.

**Architecture:** Keep the plugin hook as a host-level guard, but make its boundary fail-closed: activation requires a fresh trusted-hook heartbeat and an external one-time approval artifact; active runs bind to the Codex session and random run ID; generic shell execution is denied. Use safe path validation, complete patch parsing, post-tool accounting, and a recoverable state journal. Document the remaining same-UID/non-kernel limitation instead of claiming sandbox isolation.

**Tech Stack:** Node.js ESM, Node built-ins, Codex `SessionStart`/`PreToolUse`/`PostToolUse` hooks, Node test runner.

---

### Task 1: Reproduce the audit findings

**Files:**
- Test: `tests/codex/policy.test.mjs`
- Test: `tests/codex/hook.test.mjs`
- Test: `tests/codex/state.test.mjs`
- Test: `tests/codex/receipt.test.mjs`

Add failing adversarial cases for shell/interpreter execution, secret reads, symlinked scope, patch move destinations, actual `tool_input.command`, expiry terminal state, session binding, post-tool accounting, stale locks, and semantic receipt verification. Run `rtk npm run test:codex`; each new case must fail for the current reason before implementation.

### Task 2: Harden contract, approval, and identity binding

**Files:**
- Modify: `plugins/bounded/src/contract.mjs`
- Modify: `plugins/bounded/src/state.mjs`
- Modify: `plugins/bounded/bin/bounded.mjs`
- Test: `tests/codex/contract.test.mjs`
- Test: `tests/codex/state.test.mjs`
- Test: `tests/codex/cli.test.mjs`

Add a session/run identity, plugin-data state root, trusted-hook heartbeat, and one-time external approval artifact. Block lifecycle commands from the hook; external activation must consume an approval artifact bound to contract, session, hook digest, and expiry. Preserve explicit user control and reject missing/mismatched identity.

### Task 3: Make persisted state fail-closed and recoverable

**Files:**
- Modify: `plugins/bounded/src/state.mjs`
- Modify: `plugins/bounded/src/receipt.mjs`
- Test: `tests/codex/state.test.mjs`
- Test: `tests/codex/receipt.test.mjs`

Persist `expired` and other terminal states instead of converting expiry to `inactive`. Add a write-ahead journal for activation and terminal transitions, idempotent recovery, validated stale-lock recovery, private ancestor checks, and semantic receipt validation against the expected contract/run and counters.

### Task 4: Close policy and hook bypasses

**Files:**
- Modify: `plugins/bounded/src/policy.mjs`
- Modify: `plugins/bounded/hooks/bounded-hook.mjs`
- Modify: `plugins/bounded/hooks/hooks.json`
- Test: `tests/codex/policy.test.mjs`
- Test: `tests/codex/hook.test.mjs`

Use Codex’s canonical `tool_input.command` for Bash and `apply_patch`; deny generic shell execution during active runs; require safe non-symlink paths under the project, reject sensitive read paths, parse patch add/update/delete/move destinations, bind reservations to `tool_use_id`, and reconcile actual post-tool response bytes through `PostToolUse`.

### Task 5: Harden CLI output and documentation

**Files:**
- Modify: `plugins/bounded/bin/bounded.mjs`
- Modify: `plugins/bounded/README.md`
- Modify: `docs/bounded-plugin.md`
- Modify: `plugins/bounded/skills/bounded-autonomy/SKILL.md`
- Test: `tests/codex/cli.test.mjs`

Make `plan --output` create-only with private real parent directories. Document the external approval flow, `PLUGIN_DATA`/state-root requirement, hook trust prerequisite, supported tool boundary, post-tool accounting, and residual same-UID/non-kernel risks.

### Task 6: Verify and obtain independent review

Run, with fresh output:

```sh
rtk npm run test:codex
rtk npm test
python3 <codex-skill-root>/plugin-creator/scripts/validate_plugin.py plugins/bounded
rtk git diff --check
```

Then run the read-only Sol 5.6 medium audit against the changed plugin and tests. Do not commit, publish, install, or push. Update the project vault note with the resulting verdict and any residual findings.
