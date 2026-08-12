# Bounded Autonomous Runtime Handoff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `bounded` with a standalone runtime that owns admission, execution, containment, recovery, receipts, and rollback. Codex is an adapter, not the authority; `omp-bounded` remains historical and local.

**Architecture:** A deep `bounded-runtime` module runs as an independent process plus an independent host guard. The Codex plugin talks to it through a versioned local protocol. Reuse the proven OMP core by extraction, but do not make the released runtime depend on OMP, its process, or its plugin.

**Tech Stack:** Node.js ESM, Unix-domain JSONL protocol, private atomic state/journal, bubblewrap (or an equivalent explicit sandbox), systemd user guard/reconciler, shell-free subprocess spawning.

---

## Handoff

**Status:** design and implementation handoff; no autonomous runtime has been implemented yet.

**Release boundary:** the `bounded` artifact contains both the Codex plugin and the runtime. An installation must work with no OMP checkout, OMP process, or OMP environment.

**Current baseline:** `plugins/bounded` is independent as a plugin, but its enforcement is hook-level and advisory. The historical OMP tree contains the stronger controller, sandbox, recovery state, receipts, and systemd guard, but it is not yet packaged as a product-independent runtime.

**Current audit position:** Sol accepted `bounded@0.1.0` only as a documented advisory host guardrail. It is not an acceptable hard security or autonomous-execution boundary. The runtime work exists to close that product gap, not to relabel the current hooks.

## Gap, cost, and risks

The missing piece is a separately runnable runtime process with an external recovery authority. It must be extracted from the historical OMP implementation, given a stable protocol, packaged inside `bounded`, and verified on a clean supported host.

Expected cost is a multi-phase refactor: protocol and state-machine tests, core extraction, worker sandboxing, systemd guard installation, Codex adapter reduction, clean-host end-to-end tests, and compatibility documentation.

Known risks:

- Linux, Node, bubblewrap, and systemd become first-release host prerequisites.
- A same-UID compromised process can still tamper with user-owned state; this is not a multi-tenant security boundary.
- Guard/reconciler, leases, stale processes, reboot recovery, and concurrent runs need explicit tests.
- Existing Codex sessions, hosted tools, and hook opt-outs cannot be retroactively sandboxed; only runtime-owned worker execution is in the hard boundary.
- Extracting behavior without duplicating policy is the main architectural risk.

These constraints are accepted for this handoff. Do not claim autonomous or hard containment until the acceptance tests below pass.

## Product contract

`bounded-runtime` is the sole authority for a run. Its small public interface is:

```text
plan(contract)                 -> immutable plan/digest
approve(run, operatorProof)    -> approved run
activate(run)                  -> running run + lease
status(run)                    -> state + receipt summary
complete(run, acceptance)      -> completed run
rollback(run, reason)          -> restored run
doctor()                       -> host/runtime readiness
```

The protocol is versioned, local-only, and private to the user. Every mutating request is bound to the contract digest, run id, session/client id, lease, and monotonic counters. The runtime rejects invalid, expired, pending, or already-terminal transitions.

The runtime owns:

- contract validation and operator approval;
- the state machine, private state root, journal, locks, and crash recovery;
- worker creation, environment, writable roots, deadlines, byte limits, and sandbox policy;
- verifier/acceptance and output receipts;
- the independent guard/reconciler and exact baseline restoration;
- rollback, residue cleanup, and doctor diagnostics.

The Codex plugin owns only:

- translating Codex commands and hook events into runtime requests;
- displaying status and receipts;
- refusing or warning when the runtime is unavailable;
- plugin documentation and user-facing skill guidance.

It must not maintain a second authoritative contract, policy, ledger, approval state, or rollback implementation.

## Target layout

Keep the product self-contained under `plugins/bounded/`:

```text
plugins/bounded/
  runtime/
    bin/bounded-runtime.mjs
    src/controller.mjs
    src/contract.mjs
    src/policy.mjs
    src/executor.mjs
    src/verifier.mjs
    src/state.mjs
    src/receipt.mjs
    src/guard.mjs
    src/protocol.mjs
    systemd/
  bin/bounded.mjs              # thin runtime client
  hooks/bounded-hook.mjs       # thin Codex adapter
  .codex-plugin/plugin.json
```

The exact move can be incremental: first establish tests around the existing `core/` behavior, then extract it into `plugins/bounded/runtime/` without changing semantics. `core/`, `adapters/`, `extensions/`, and `systemd/` at repository root remain local historical/reference code during migration. The released plugin must not import them or require them at runtime.

## Implementation sequence

### 1. Freeze the runtime seam

Add `tests/runtime/contract.test.mjs`, `tests/runtime/state.test.mjs`, and `tests/runtime/protocol.test.mjs` before moving code.

Specify and test:

- lifecycle transitions and terminal states;
- digest/run/session/lease binding;
- atomic journal recovery and stale-lock handling;
- protocol errors and idempotent status/rollback;
- no external-effect operations in a contract.

The tests must run with the OMP directories absent from the module path.

### 2. Extract the controller and state authority

Create the runtime modules listed above by moving or adapting the existing OMP controller/state/receipt/policy logic. Preserve behavior first; simplify only after parity tests pass.

Required seam:

```text
client/adapter -> protocol -> controller -> executor/guard/state/verifier
```

No runtime module may call Codex hooks or OMP extensions. No adapter may mutate runtime state files directly.

### 3. Make execution genuinely autonomous

Implement `runtime/bin/bounded-runtime.mjs` as a long-lived process (or supervised one-shot service) that can continue after its client exits.

The controller must launch the worker itself, with:

- explicit argv spawning, never an interpolated shell command;
- bubblewrap or equivalent filesystem/process/network containment;
- only contract-declared writable roots and output paths;
- no credentials, ambient agent sockets, or undeclared environment;
- hard process termination on deadline and output-budget exhaustion;
- verifier-driven completion, otherwise rollback.

The client disconnecting is a runtime event, not authorization to complete or to clear pending state.

### 4. Make recovery external to the worker

Add the systemd user guard/reconciler and lease protocol under `plugins/bounded/runtime/systemd/`.

Test process death, runtime death, worker death, reboot/stale lease, deadline, drift, failure, and successful completion. The guard must restore the protected baseline and remove residue without relying on the Codex process being alive.

### 5. Reduce the Codex plugin to an adapter

Update `plugins/bounded/bin/bounded.mjs`, `plugins/bounded/hooks/bounded-hook.mjs`, the plugin skill, `plugins/bounded/README.md`, and `docs/bounded-plugin.md`.

The CLI becomes a client of the runtime protocol. Hooks report context and enforce the supported integration seam, but they do not pretend to sandbox arbitrary host tools. If the runtime is unavailable, activation fails closed. The docs must distinguish runtime guarantees from hook coverage.

Add an independence test that copies the plugin/runtime to a temporary directory and runs `doctor`, `plan`, `activate`, `status`, and `rollback` with OMP files, variables, and processes absent.

### 6. Package and verify the first release

Add the supported-host installer/doctor path and fixture configuration. Do not add publish, push, deploy, or marketplace automation in this handoff.

Required verification:

```text
rtk npm run test:codex
rtk npm test
python3 <codex-skill-root>/plugin-creator/scripts/validate_plugin.py plugins/bounded
node --check <every runtime and adapter .mjs file>
rtk git diff --check
```

The clean-host suite must run with a fresh user state root and prove that the runtime starts, executes a bounded fixture, survives client death, restores after forced runtime/worker death, and leaves no undeclared output.

## Acceptance criteria

Release `bounded` as autonomous only when all are true:

1. The runtime starts and runs without Codex, OMP, or the historical `omp-bounded` tree.
2. Killing the client does not disable the active guard or convert a pending run into completion.
3. Worker execution is sandboxed; path traversal, symlink escape, sensitive reads, undeclared writes, network, and shell injection tests fail closed.
4. Deadline and output limits terminate the worker, produce a failure receipt, and restore the baseline.
5. Runtime/worker death, reboot recovery, stale leases, and drift restore the exact protected state.
6. Receipts bind contract, run, session, lease, counters, outputs, and terminal result; they verify after restart.
7. The plugin contains no duplicated authority and has no runtime import or process dependency on OMP.
8. Documentation states the same-UID trust boundary and the unsupported coverage of pre-existing/hosted/hook-opt-out execution.

## Non-goals

- Making `omp-bounded` the canonical product or a runtime dependency.
- Treating Codex hooks alone as a kernel sandbox.
- Multi-user adversarial isolation against a process with the same Unix account.
- Authorization for publish, push, deploy, network calls, or credential use.
- Publishing or installing the release without a separate user decision.

## Handoff decision

Proceed by extracting the historical OMP runtime machinery into a self-contained `bounded` runtime and making the current plugin a thin adapter. Do not extend the current hook-local state machine as the final architecture: it cannot provide autonomy after the client exits or hard containment of the worker.

## Implementation checkpoint — 2026-08-11

The self-contained runtime is implemented under `plugins/bounded/runtime/`. Contract, JSONL protocol, atomic state/journal, lease recovery, bubblewrap worker, explicit artifact verifier, receipts, delivery/rollback, doctor, guard units, CLI, and Codex adapters are covered by tests. `npm test`, plugin validation, syntax checks, diff checks, and the copied-plugin no-OMP test are green.

The supported-host systemd user units are rendered and tested but have not been installed or enabled on the shared machine. Clean-host systemd E2E remains the gated next step; no publish, push, deploy, or persistent installation was performed.

Review corrections applied after the first implementation checkpoint: the guard now leaves an unexpired live runtime untouched and only reconciles a dead runtime; activation binds a protected baseline digest and detects/restores drift; worker PID/start-time identity is persisted and required; intermediate input/project-root symlinks fail closed; the verifier identity and deterministic acceptance check are runtime-bound; and delivery journals, temp files, receipt, and directory durability remain recoverable until terminal state is durable.

## Installation and systemd E2E checkpoint — 2026-08-12

With explicit user authorization, installed the user-scoped `bounded-runtime-guard.{service,timer}` for the current checkout. `Linger=yes`; the timer is enabled and active. `doctor`, the guard service, and `systemd-analyze verify` pass; the analyzer reports one unrelated pre-existing service warning.

Real user-timer E2E passed: a bounded worker was activated, the runtime PID was killed, the timer invoked the guard, and the run became `rolled-back` with a valid receipt (`runtime process is unavailable`) and no delivered output. No worker remained. The full `npm test` suite passed with exit 0. No publish, push, deploy, or marketplace action was performed.

## Follow-up checkpoint — preserve-for-review — 2026-08-12

Added an explicit `stopPolicy.onFailure = preserve-for-review` and CLI flag `--on-failure preserve-for-review`. The live project still returns to its activation baseline; validated declared artifacts remain in private quarantine and are reported by `status`. Unknown policies and unsafe/undeclared quarantine contents fail closed to rollback; explicit operator rollback always forces rollback.

The persistent runtime was restarted and a real state-root fixture passed with a valid `preserved` receipt and retained artifact. Focused tests, full `npm test`, plugin validation, syntax checks, and diff checks are green.

## Next handoff — global multi-harness installation

The follow-up design for extracting the runtime from the checkout, supporting Linux/macOS, and adding OpenAI, Claude, Kiro, oh-my-pi, and generic adapters is documented in `docs/plans/2026-08-12-global-multiharness-installation-handoff.md`. The main unresolved technical risk is proving a macOS containment backend before claiming Linux-equivalent guarantees.
