import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createContract } from '../../plugins/bounded/src/contract.mjs';
import { createStateStore } from '../../plugins/bounded/src/state.mjs';

const NOW = '2026-08-11T12:00:00.000Z';
const SESSION_ID = 'thr_bounded_test';
const HOOK_DIGEST = `sha256:${'a'.repeat(64)}`;

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-state-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-project-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const contract = createContract({
    cwd,
    task: 'update a local file',
    acceptanceCheck: 'node --test test/local.test.mjs',
    scope: ['src/index.mjs'],
    maxSeconds: 30,
    maxReadBytes: 4096,
    maxArtifactBytes: 4096,
    maxOutputBytes: 4096,
    maxRequests: 2,
    prohibitedEffects: 'all external effects',
    finalGate: 'human-approval',
    ...overrides,
  }, { now: NOW });
  return { root, cwd, contract, store: createStateStore({ root }) };
}

function activate(store, contract) {
  store.recordHeartbeat(contract.cwd, { sessionId: SESSION_ID, hookDigest: HOOK_DIGEST, now: NOW });
  const issued = store.createApproval(contract, { now: NOW, hookDigest: HOOK_DIGEST });
  return store.activate(contract, {
    approvalPath: issued.approvalPath,
    hookDigest: HOOK_DIGEST,
    now: NOW,
  });
}

test('rejects an explicit state root that disagrees with the hook environment', (t) => {
  const { root } = fixture(t);
  const previous = process.env.BOUNDED_STATE_ROOT;
  process.env.BOUNDED_STATE_ROOT = path.join(root, 'hook-root');
  t.after(() => {
    if (previous === undefined) delete process.env.BOUNDED_STATE_ROOT;
    else process.env.BOUNDED_STATE_ROOT = previous;
  });
  assert.throws(() => createStateStore({ root: path.join(root, 'other-root') }), /explicit state root|state root/i);
});

test('requires an external approval and binds the run to session identity', (t) => {
  const { cwd, contract, store } = fixture(t);

  assert.throws(() => store.createApproval(contract, { now: NOW, hookDigest: HOOK_DIGEST }), /heartbeat/i);
  assert.throws(() => store.activate(contract, { confirmation: contract.digest, now: NOW }), /approval|hook/i);
  const active = activate(store, contract);
  assert.equal(active.status, 'active');
  assert.equal(active.contractDigest, contract.digest);
  const persisted = store.read(cwd);
  assert.equal(persisted.state.sessionId, SESSION_ID);
  assert.match(persisted.state.runId, /^[a-f0-9]{64}$/);
  assert.equal(store.status(cwd, { now: NOW }).status, 'active');
  const approvalPath = path.join(store.paths(cwd).approvals, fs.readdirSync(store.paths(cwd).approvals)[0]);
  assert.throws(() => store.activate(contract, { approvalPath, hookDigest: HOOK_DIGEST, now: NOW }), /used|approval|active/i);

  const reserved = store.reserve(cwd, { now: NOW, sessionId: SESSION_ID, toolUseId: 'tool-1', toolName: 'Write', artifactBytes: 200 });
  assert.equal(reserved.requestCount, 1);
  assert.equal(reserved.readBytes, 0);
  assert.equal(reserved.artifactBytes, 200);
  const settled = store.settle(cwd, {
    now: NOW,
    sessionId: SESSION_ID,
    toolUseId: 'tool-1',
    readBytes: 100,
    outputBytes: 50,
  });
  assert.equal(settled.readBytes, 100);
  assert.equal(settled.outputBytes, 50);
});

test('reconciles expiry and records explicit completion receipts', (t) => {
  const expired = fixture(t, { maxSeconds: 1 });
  activate(expired.store, expired.contract);
  assert.equal(expired.store.status(expired.cwd, {
    now: new Date(Date.parse(NOW) + 1000).toISOString(),
  }).status, 'expired');

  const completed = fixture(t);
  activate(completed.store, completed.contract);
  completed.store.reserve(completed.cwd, {
    now: NOW,
    sessionId: SESSION_ID,
    toolUseId: 'tool-pending',
    toolName: 'Write',
    artifactBytes: 100,
  });
  assert.throws(() => completed.store.complete(completed.cwd, {
    now: NOW,
    sessionId: SESSION_ID,
    result: 'accepted',
    acceptanceRef: 'must wait for post-tool reconciliation',
  }), /pending|reconcil/i);
  completed.store.settle(completed.cwd, {
    now: NOW,
    sessionId: SESSION_ID,
    toolUseId: 'tool-pending',
    outputBytes: 50,
  });
  const result = completed.store.complete(completed.cwd, {
    now: NOW,
    sessionId: SESSION_ID,
    result: 'accepted',
    acceptanceRef: 'human confirmed local test result',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.receipt.result, 'accepted');
  assert.equal(result.receipt.acceptanceRef, 'human confirmed local test result');
  assert.equal(completed.store.status(completed.cwd, { now: NOW }).status, 'completed');
  assert.ok(fs.readdirSync(completed.store.paths(completed.cwd).receipts).length >= 1);
});

test('fails closed when persisted state is malformed', (t) => {
  const { cwd, contract, store } = fixture(t);
  activate(store, contract);
  fs.writeFileSync(store.paths(cwd).state, '{"broken":true}\n', { mode: 0o600 });
  assert.throws(() => store.status(cwd, { now: NOW }), /state|malformed|invalid/i);
});

test('recovers a stale lock and fails closed if an activated project state disappears', (t) => {
  const { cwd, contract, store } = fixture(t);
  activate(store, contract);
  const paths = store.paths(cwd);
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: 999999, createdAt: NOW }), { mode: 0o600 });
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(paths.lock, old, old);
  assert.equal(store.status(cwd, { now: NOW }).status, 'active');

  fs.rmSync(paths.project, { recursive: true, force: true });
  assert.throws(() => store.status(cwd, { now: NOW }), /state|activated|unavailable/i);
});
