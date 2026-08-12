# Bounded Independent Codex Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Release a self-contained Codex plugin named `bounded`. The historical `omp-bounded` package is reference material only and must not be a runtime dependency, import target, or public product identity.

**Architecture:** `plugins/bounded/` owns its manifest, contract schema, state store, admission/rollback logic, local CLI, bounded policy, Codex hooks, skill, and tests. The plugin is opt-in: outside an active contract it is inert; while active, malformed or unavailable state fails closed for tool calls. It enforces local scope, budgets, deadlines, and the no-external-effects policy at the Codex hook boundary. It records a local receipt and leaves acceptance execution and final human approval explicit. Codex hooks are a host guardrail, not a kernel sandbox; the README must state that limit.

**Tech Stack:** Codex plugin manifest, Codex hook JSON, Node.js ESM with the standard library only, `node:test`, local plugin validator.

---

### Task 1: Lock the independent public contract

**Files:**
- Create: `tests/codex/plugin-contract.test.mjs`
- Create: `tests/codex/contract.test.mjs`
- Create: `plugins/bounded/.codex-plugin/plugin.json` (implementation in Task 2)

1. Write failing tests that assert:
   - the manifest name is exactly `bounded` and the first version is `0.1.0`;
   - the public manifest has no OMP identity, app, or MCP surface;
   - every runtime import under `plugins/bounded/` resolves inside that package or Node built-ins;
   - the independent contract accepts a valid bounded request and rejects widened scope, external effects, invalid budgets, stale deadlines, and credential-looking input.
2. Run the focused tests and confirm RED because the independent package does not exist yet.

### Task 2: Implement the independent contract and state primitives

**Files:**
- Create: `plugins/bounded/src/contract.mjs`
- Create: `plugins/bounded/src/state.mjs`
- Create: `plugins/bounded/src/receipt.mjs`
- Create: `plugins/bounded/src/policy.mjs`

1. Add the smallest pure contract constructor/validator with a versioned `bounded-*` schema, canonical serialization, digest binding, relative writable paths, 1–300 second deadlines, finite request/read/output budgets, `externalEffects.enabled === false`, and `finalGate === human-approval`.
2. Add private, atomic state reads/writes and an exclusive lock under the user state directory; reject symlinks, unsafe permissions, malformed state, digest drift, and expired active contracts.
3. Add receipt creation and verification for admission, rollback, and completion outcomes without secrets.
4. Add the policy predicates used by both the CLI and hooks. Keep policy decisions deterministic and side-effect free.
5. Run the focused tests and confirm GREEN before adding host integration.

### Task 3: Implement the standalone local CLI

**Files:**
- Create: `plugins/bounded/bin/bounded.mjs`
- Create: `tests/codex/cli.test.mjs`

1. Add `plan`, `activate`, `status`, `rollback`, and `complete` commands.
2. `plan` prints the canonical contract and digest; it never activates a run.
3. `activate` requires an exact digest confirmation from outside the Codex tool stream, validates the contract again, and creates the active state atomically.
4. `status` reconciles expiry; `rollback` restores an inactive state and writes a receipt; `complete` requires an explicit human result and records the acceptance reference without executing an arbitrary command.
5. Make unavailable, corrupt, or drifted state fail closed and return nonzero exit codes.

### Task 4: Add Codex hook enforcement

**Files:**
- Create: `plugins/bounded/hooks/hooks.json`
- Create: `plugins/bounded/hooks/bounded-hook.mjs`
- Create: `tests/codex/hook.test.mjs`

1. Test synthetic `SessionStart` and `PreToolUse` JSON before wiring the hook.
2. On session start, reconcile the current project state and inject only the active bounded status.
3. On pre-tool calls during an active run:
   - deny missing, invalid, expired, or drifted state;
   - deny unknown or agent/MCP dispatch tools;
   - enforce the request budget and project binding;
   - enforce scope for patch/edit/write inputs;
   - reject known external-effect and credential patterns in shell input;
   - allow only deterministic local reads and in-scope local edits.
4. Outside an active run, emit no policy decision so normal Codex use is unchanged.
5. Fail closed on malformed input and never print secrets or contract contents into hook diagnostics.

### Task 5: Package the skill and documentation

**Files:**
- Create: `plugins/bounded/skills/bounded-autonomy/SKILL.md`
- Create: `plugins/bounded/README.md`
- Create or update: `docs/bounded-plugin.md`

1. Document the public `$bounded-autonomy` workflow: plan, human activation, bounded edits, acceptance, and explicit completion/rollback.
2. State the first-release limits precisely: independent from OMP, local-only, no MCP, no publish/deploy, and hook enforcement is not a kernel sandbox or a guarantee against every shell indirection.
3. Keep `omp-bounded` out of the plugin’s runtime files and public manifest; mention it only in repository-local historical notes where needed.

### Task 6: Verify and hand off

**Files:**
- Update: `package.json` only if a named focused test command is needed.
- Update: the Obsidian project handoff note after verification.

1. Run the focused Codex tests.
2. Run the plugin validator on `plugins/bounded`.
3. Run the existing OMP, install, cross-runtime, and clean-host suites unchanged.
4. Scan the independent package for imports, schemas, environment variables, and paths that cross into the historical OMP package.
5. Leave publish, push, deploy, persistent install, and marketplace registration gated for the user.
