# Global Multi-Harness Installation Handoff

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `bounded` installable once per user on Linux and macOS, with one portable runtime, an Agent Plugins package, native adapters for Codex, Claude Code, OMP/oh-my-pi, and a generic CLI fallback.

**Architecture:** The runtime is the only authority for contracts, worker containment, leases, receipts, delivery, quarantine, and recovery. Harness integrations are thin packages that discover the same `bounded` executable and translate their native skill/hook/extension format into the runtime CLI; they never duplicate runtime state or rollback logic.

**Tech Stack:** Node.js 22 ESM, npm package/tarball, JSONL Unix-domain protocol, bubblewrap + systemd user guard on Linux, launchd user agent plus a macOS sandbox backend, Agent Plugins skills/MCP, Codex and Claude plugin hooks, OMP/oh-my-pi JavaScript hooks.

---

## Decision summary

Build one user-scoped product with four layers:

```text
bounded install --user
        |
        +-- portable runtime + CLI       ~/.local/share/bounded/<version>
        +-- user state                    platform state directory
        +-- platform guard                systemd user | launchd user agent
        +-- detected adapters             Agent Plugins | Codex | Claude | OMP/oh-my-pi
```

Agent Plugins is the portable package surface: root `plugin.json`, `skills/`, and optional `mcp.json`. Its v1 contract is a portability floor, not a security boundary, and does not standardize hooks, agents, or commands. Keep the Codex package manifest as a native wrapper; do not call it the portable standard. Pin the exact Agent Plugins schema and the current Codex manifest contract in separate tests: <https://agent-plugins.org/specification>, <https://developers.openai.com/plugins/build/plugins>.

Claude is the main format exception: its native plugin is a directory with its own manifest and component layout. Claude supports plugin skills, agents, hooks, MCP, and other components; hooks live in `hooks/hooks.json` and use Claude-specific lifecycle events and variables: <https://code.claude.com/docs/en/plugins-reference>.

OMP/oh-my-pi gets a native adapter, not a fake universal plugin. It loads JavaScript/TypeScript hook factories through its extension discovery and `HookAPI`: <https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md>.

## Supported-host contract

### Linux v1

- Node.js 22.
- bubblewrap required for bounded workers.
- systemd user session required for the external guard.
- Install guard as `bounded-runtime-guard.service` and `.timer` in the user unit directory.
- Use `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CONFIG_HOME` when set; otherwise use the standard user defaults.
- Preserve the current same-UID trust boundary and the existing clean-host E2E.

### macOS v1 target

- macOS 13+ on Apple Silicon and Intel, Node.js 22.
- Use a per-user `launchd` LaunchAgent in `~/Library/LaunchAgents/` for periodic reconciliation.
- Do not use systemd paths or Linux-only assumptions in the portable runtime.
- Implement a platform worker backend behind one interface: `spawnBoundedWorker(contract)`.
- The backend must prove filesystem, process, and network restrictions on each supported macOS version before claiming hard containment.

The macOS sandbox is the material unresolved risk. A first spike may evaluate the available Seatbelt/sandbox tooling, but the result must be treated as a capability probe, not assumed parity with bubblewrap. If the probe cannot prove the required boundary, ship macOS as “runtime + recovery + advisory containment” and say so explicitly; do not silently downgrade the Linux guarantee.

## Package layout

Refactor the current checkout into a distributable package without making the installed runtime depend on the source checkout:

```text
packages/bounded-runtime/
  bin/bounded
  runtime/bin/bounded-runtime.mjs
  runtime/src/...
  platform/linux/...
  platform/macos/...
  install.mjs
  uninstall.mjs
  doctor.mjs
adapters/
  agent-plugins/
    skills/bounded-autonomy/SKILL.md
    plugin.json
  claude/
    .claude-plugin/plugin.json
    skills/bounded-autonomy/SKILL.md
    hooks/hooks.json
  omp-ohmy-pi/
    bounded-hook.mjs
  generic/
    README.md
```

Keep one source of truth for user-facing workflow text where possible, then render/validate native adapter files. The generated adapters may differ in syntax, but must expose the same commands, policy language, and trust-boundary warnings.

## User-scoped installation

The public entry point should be:

```bash
npx bounded install --user --detect
# or, after installation:
bounded doctor
bounded adapter list
  bounded adapter install claude
```

Installation requirements:

1. Resolve the package version and copy it to a versioned immutable directory.
2. Point a stable launcher (`~/.local/bin/bounded`) at the selected version.
3. Create the private state root with mode `0700`.
4. Install and enable the platform guard only after a successful dry-run and doctor check.
5. Detect, report, and separately install adapters; never mutate an unknown harness directory.
6. Write an installation manifest containing package version, platform backend, paths, adapter versions, and digests.
7. Upgrade atomically: install new version, run doctor/tests, switch `current`, reload guard, then retain the prior version for rollback.
8. Uninstall only files owned by the manifest; refuse to delete replaced or user-modified files.

Suggested paths:

| Item | Linux | macOS |
|---|---|---|
| Versioned runtime | `$XDG_DATA_HOME/bounded/<version>` | `~/Library/Application Support/bounded/<version>` |
| State | `$XDG_STATE_HOME/bounded` | `~/Library/Application Support/bounded/state` |
| Config/manifest | `$XDG_CONFIG_HOME/bounded` | `~/Library/Preferences/bounded` |
| CLI | `~/.local/bin/bounded` | `~/.local/bin/bounded` |
| Guard | systemd user service/timer | `~/Library/LaunchAgents/com.bounded.guard.plist` |

The installer must support `--dry-run`, `--runtime-only`, `--adapter <name>`, `--no-adapters`, `--uninstall`, and `--doctor`. It must not publish, push, deploy, install system-wide files, or require root.

## Adapter contract

Every adapter must provide the same logical surface:

- explain bounded mode and its fixed limits;
- invoke `bounded doctor` before activation;
- create/show an immutable plan;
- request explicit approval and activation;
- report status and preserved-review paths;
- offer complete, rollback, and review actions;
- deny or warn only at the host integration seam; never claim to sandbox tools the host does not route through bounded.

The runtime CLI is the fallback and the compatibility contract. A host-specific hook is optional and advisory unless the host documents a pre-tool blocking hook.

### Agent Plugins adapter

- Package the portable root `plugin.json`, `skills/`, and only the MCP configuration actually needed.
- Keep the existing Codex plugin manifest as a separate native wrapper, not as the portable package.
- Add schema and path-containment contract tests for the Agent Plugins package.
- Do not claim direct host compatibility without a versioned adapter/smoke test.

### Claude adapter

- Ship a real `.claude-plugin/plugin.json`.
- Put skills at plugin-root `skills/`, not inside `.claude-plugin/`.
- Translate the current Claude hook contract to `${CLAUDE_PLUGIN_ROOT}` and Claude lifecycle events.
- Test `PreToolUse`, `PostToolUse`, `SessionStart`, and plugin reload behavior.
- Keep Claude hooks advisory for tools outside the bounded CLI seam.

### OMP/oh-my-pi adapter

- Ship a native default-export hook factory.
- Bind `tool_call` and `tool_result` only to the runtime CLI/status seam.
- Register a small review command for preserved artifacts if the current `HookAPI` supports it.
- Preserve the existing OMP adapter and add a native hook factory only if the host is distinct from OMP.
- Test extension discovery from a versioned package path and explicit configured path.

### Generic adapter

Always install the CLI documentation and shell completion if available. Generic harnesses can use `bounded plan/approve/activate/status/complete/rollback` directly, but no host-level blocking guarantee is made.

## Preserve-for-review requirements

The current runtime retains failed declared artifacts in private quarantine. Before global packaging, add the missing operator lifecycle:

```text
bounded review list
bounded review show <run-id>
bounded review apply <run-id> [--paths ...]
bounded review discard <run-id>
```

`apply` must re-check the activation baseline, refuse unexpected project drift, copy only declared regular files, preserve modes, use an atomic journal, and require explicit confirmation. `discard` must delete only the exact quarantine directory named by a valid receipt. Both operations must be receipt-bound and tested after restart.

## Implementation sequence

### Phase 1: Portable runtime extraction

Move the existing runtime and CLI behind a stable package root. Remove checkout paths from rendered units, launcher output, tests, and docs. Add package-version and installation-manifest validation.

### Phase 2: Platform backends

Keep the Linux backend green. Add launchd rendering, install/uninstall, timer/reconciliation tests, and a macOS worker-containment spike. Gate the macOS support level on measured capabilities.

### Phase 3: Portable Agent Plugins surface

Add the Agent Plugins root package with schema/path contract tests, keep its skill content aligned with the native adapters, and make it call only the stable CLI through documented workflow text.

### Phase 4: Native adapters

Implement and test Codex, Claude, and OMP/oh-my-pi adapters independently. Their tests must pass with the runtime package installed from a temporary versioned directory, not from the repository checkout.

### Phase 5: Review lifecycle and release

Implement `review list/show/apply/discard`, cross-platform receipts, upgrade/uninstall recovery, shell completion, and a compatibility matrix. Produce signed or digest-pinned release artifacts only after the user separately authorizes publication.

## Verification matrix

Required CI/host checks:

| Area | Linux | macOS |
|---|---:|---:|
| Fresh user install from package | yes | yes |
| No checkout-path dependency | yes | yes |
| `doctor` and manifest validation | yes | yes |
| Worker deadline/output limits | yes | yes |
| Filesystem/network/process containment | bubblewrap E2E | backend-specific E2E or explicitly advisory |
| Client death | yes | yes |
| Runtime/worker death | yes | yes |
| Reboot/login recovery | systemd timer | launchd agent |
| Drift and delivery recovery | yes | yes |
| Preserve-for-review after restart | yes | yes |
| Claude plugin load/hooks | fixture | fixture where Claude is available |
| oh-my-pi extension discovery | fixture | fixture where oh-my-pi is available |

Acceptance criteria:

1. A fresh install runs without the repository or OMP environment.
2. Linux retains the existing hard runtime claims and E2E results.
3. macOS has a measured, documented containment level; no Linux guarantee is copied by wording alone.
4. One runtime state/receipt schema is shared by every adapter.
5. Codex, Claude, and OMP/oh-my-pi can invoke the same CLI lifecycle without mutating runtime files directly.
6. An interrupted upgrade or uninstall is recoverable and never deletes unowned files.
7. Preserved artifacts can be listed, inspected, explicitly applied, or discarded.
8. No publish, push, deploy, marketplace submission, or system-wide installation is part of implementation without a separate user decision.

## Known gaps and explicit non-goals

- Agent Plugins compatibility is treated as a verified portable adapter only after its v1 schema and host discovery are pinned in tests; its current status remains a working draft.
- Codex’s native `.codex-plugin/plugin.json` is not interchangeable with the Agent Plugins root `plugin.json`.
- Claude’s plugin format is not interchangeable with the OpenAI format.
- OMP/oh-my-pi hooks are integration surfaces, not sandbox boundaries.
- macOS hard containment is the primary technical risk and must be resolved by a host spike.
- Windows, remote/hosted harnesses, multi-user adversarial isolation, credentials, network effects, and automatic publication are out of scope for this handoff.

## Handoff state

Implemented in this checkout, without Kiro and without changing the existing OMP installer:

- the self-contained `plugins/bounded/` runtime remains the authority and the stable CLI entry point is `scripts/bounded.mjs` (`bin.bounded` in `package.json`);
- Agent Plugins, native Codex, native Claude, and native OMP/oh-my-pi packages are separate adapter surfaces;
- the global installer copies the runtime and selected adapters into a versioned user store, switches an atomic `current` symlink, writes a digest-bound manifest, renders a user-scoped Linux systemd guard or a macOS LaunchAgent advisory guard, and provides doctor/uninstall;
- installed launcher and guard paths point to the versioned store, never to the checkout;
- dry-run, runtime-only/no-adapter, adapter selection, doctor, adapter list, uninstall, digest drift, Linux guard, macOS advisory guard, Claude hooks, and OMP hook discovery contracts are tested.

Verification: `npm test` passes, including 4 skill, 29 runtime, 22 Codex, 8 adapter, 27 OMP, and 61 install tests. No user/system-wide installation, publish, push, deploy, or marketplace action was performed.

Residual limits: the Agent Plugins v1 document is still a Working Draft; macOS containment is explicitly advisory because no parity proof with bubblewrap exists; upgrade retention/rollback and the review `list/show/apply/discard` operator commands remain the next hardening phase. The existing OMP installer remains checkout-oriented by design and is not the global installer.
