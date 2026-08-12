# bounded-agent Public Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Assemble a neutral, non-private `bounded-agent` npm package whose `bounded` CLI runs without the historical checkout.

**Architecture:** Keep the root package and compatibility suites unchanged. A deterministic assembly script copies the existing standalone CLI, runtime, skill, systemd templates, and three native adapter directories into a clean package directory; the generated package manifest uses an allowlist so the assembly tooling and legacy tree cannot enter the tarball. The optional oh-my-pi adapter is discoverable by explicit selection but is not a core default. The public package is MIT-licensed.

**Tech Stack:** Node.js 22 ESM, npm tarball install in an isolated prefix, Node built-ins, `node:test`.

---

### Task 1: Lock the public package contract

**Files:**
- Create: `tests/package/public-package.test.mjs`
- Create: `docs/plans/2026-08-12-bounded-agent-public-distribution.md`

Write tests that assemble into a temporary directory, inspect the manifest and `npm pack --dry-run`, assert the exact name/bin/privacy, required and excluded paths, forbidden identity/credential/checkout text, and a clean-HOME CLI dry-run.

Run: `node --test tests/package/public-package.test.mjs`
Expected: FAIL because the assembly entry point does not exist.

### Task 2: Implement the deterministic assembly

**Files:**
- Create: `packages/bounded-agent/assemble.mjs`
- Create: `packages/bounded-agent/README.md`
- Create: `adapters/omp-ohmy-pi/README.md`
- Modify: `scripts/global-install.mjs`

Generate `dist/bounded-agent` or a supplied destination from the existing standalone sources, write `package.json` with version `0.1.1`, MIT license, and an allowlist for public files. Dynamically discover non-core adapter directories so the optional host adapter is not a core dependency or product metadata in the core script.

Run the focused test again and expect it to pass.

### Task 3: Verify the release boundary

Run:

```text
node --test tests/package/public-package.test.mjs
npm run test:runtime
npm run test:codex
npm run test:adapters
npm run test:install
npm run test:omp
git diff --check
```

Run the assembled-package E2E: pack the payload, install the tarball into a temporary npm prefix, execute `node_modules/.bin/bounded-agent`, verify real user-scoped installation and launcher doctor/uninstall, and exercise duplicate-install rejection. A live registry/`npx` test remains a separate publish-gated check. Do not publish, push, deploy, log in, or install system-wide.
