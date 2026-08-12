import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createContract } from '../../plugins/bounded/runtime/src/contract.mjs';
import {
  createInitialState,
  createStateStore,
  recoverState,
  transition,
} from '../../plugins/bounded/runtime/src/state.mjs';

const NOW = '2026-08-11T12:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function contract() {
  return createContract({
    cwd: '/tmp/bounded-project',
    clientId: 'codex-client-1',
    sessionId: 'session-1',
    toolCallId: 'tool-call-1',
    trigger: { id: 'manual', value: 'operator request' },
    task: { id: 'task', value: 'local bounded task' },
    acceptanceCheck: { id: 'tests', value: 'node --test test/index.test.mjs' },
    boundedContext: { sessionPath: 'context/session.json', readPaths: ['src/index.mjs'], maxBytes: 1024 },
    writeScope: { paths: ['src/index.mjs'], patchPaths: [], maxFiles: 1 },
    verifier: { id: 'bounded-runtime-verifier', digest: 'sha256:6b4dd88cfd35f757be313b6d40a7644a793f7706a7b5308a3b1a251a61f9a73d' },
    worker: { command: process.execPath, args: ['-e', ''] },
    requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: { maxReadBytes: 1024, maxArtifactBytes: 1024, maxOutputBytes: 1024, maxRequests: 2, maxWorkers: 1 },
    delivery: { mode: 'local', outputPaths: ['src/index.mjs'], receiptPath: 'receipts/pending' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local/node'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 },
    stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    trustedStateDigest: DIGEST,
    maxSeconds: 30,
  }, { now: NOW });
}

test('accepts only the planned-to-approved-to-running terminal lifecycle', () => {
  const plan = contract();
  const planned = createInitialState(plan, { now: NOW });
  const approved = transition(planned, {
    type: 'approve',
    contractDigest: plan.digest,
    clientId: plan.clientId,
    sessionId: plan.sessionId,
    operatorProof: 'operator-confirmed-local',
    counter: 1,
    now: '2026-08-11T12:00:01.000Z',
  });
  const running = transition(approved, {
    type: 'activate',
    contractDigest: plan.digest,
    clientId: plan.clientId,
    sessionId: plan.sessionId,
    leaseId: 'lease-1',
    counter: 2,
    now: '2026-08-11T12:00:02.000Z',
  });
  const completed = transition(running, {
    type: 'complete',
    contractDigest: plan.digest,
    clientId: plan.clientId,
    sessionId: plan.sessionId,
    leaseId: 'lease-1',
    counter: 3,
    acceptance: { passed: true, digest: DIGEST },
    now: '2026-08-11T12:00:03.000Z',
  });

  assert.equal(planned.status, 'planned');
  assert.equal(approved.status, 'approved');
  assert.equal(running.status, 'running');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.leaseId, 'lease-1');
  assert.throws(() => transition(completed, {
    type: 'activate', contractDigest: plan.digest, clientId: plan.clientId, sessionId: plan.sessionId,
    leaseId: 'lease-2', counter: 4, now: '2026-08-11T12:00:04.000Z',
  }), /terminal|transition|state/i);
});

test('records preserved output as a terminal operator-review state', () => {
  const plan = contract();
  const planned = createInitialState(plan, { now: NOW });
  const approved = transition(planned, {
    type: 'approve', contractDigest: plan.digest, clientId: plan.clientId, sessionId: plan.sessionId,
    operatorProof: 'proof', counter: 1, now: '2026-08-11T12:00:01.000Z',
  });
  const running = transition(approved, {
    type: 'activate', contractDigest: plan.digest, clientId: plan.clientId, sessionId: plan.sessionId,
    leaseId: 'lease-1', counter: 2, now: '2026-08-11T12:00:02.000Z',
  });
  const preserved = transition(running, {
    type: 'preserve', contractDigest: plan.digest, clientId: plan.clientId, sessionId: plan.sessionId,
    leaseId: 'lease-1', counter: 3, reason: 'worker failed', now: '2026-08-11T12:00:03.000Z',
  });
  assert.equal(preserved.status, 'preserved');
  assert.equal(preserved.terminalReason, 'worker failed');
  assert.throws(() => transition(preserved, {
    type: 'activate', contractDigest: plan.digest, clientId: plan.clientId, sessionId: plan.sessionId,
    leaseId: 'lease-2', counter: 4, now: '2026-08-11T12:00:04.000Z',
  }), /terminal|transition|state/i);
});

test('rejects digest, session, lease, and monotonic-counter mismatches', () => {
  const plan = contract();
  const planned = createInitialState(plan, { now: NOW });

  assert.throws(() => transition(planned, {
    type: 'approve', contractDigest: `sha256:${'b'.repeat(64)}`, clientId: plan.clientId,
    sessionId: plan.sessionId, operatorProof: 'proof', counter: 1, now: NOW,
  }), /digest|binding/i);
  const approved = transition(planned, {
    type: 'approve', contractDigest: plan.digest, clientId: plan.clientId, sessionId: plan.sessionId,
    operatorProof: 'proof', counter: 1, now: '2026-08-11T12:00:01.000Z',
  });
  assert.throws(() => transition(approved, {
    type: 'activate', contractDigest: plan.digest, clientId: plan.clientId, sessionId: 'other-session',
    leaseId: 'lease-1', counter: 2, now: '2026-08-11T12:00:02.000Z',
  }), /session|binding/i);
  assert.throws(() => transition(approved, {
    type: 'activate', contractDigest: plan.digest, clientId: plan.clientId, sessionId: plan.sessionId,
    leaseId: 'lease-1', counter: 1, now: '2026-08-11T12:00:02.000Z',
  }), /counter|monotonic/i);
});

test('recovers an unfinished atomic journal and removes stale locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-state-'));
  const plan = contract();
  const store = createStateStore({ root });
  const planned = createInitialState(plan, { now: NOW });
  store.writeJournal(plan.runId, { previous: null, next: planned, contract: plan });
  assert.equal(fs.existsSync(path.join(root, `${plan.runId}.journal`)), true);
  const recovered = recoverState({ root, runId: plan.runId });
  assert.equal(recovered.state.status, 'planned');
  assert.equal(fs.existsSync(path.join(root, `${plan.runId}.journal`)), false);

  store.writeStaleLock(plan.runId, { pid: 999999, createdAt: NOW });
  assert.equal(store.reconcile(plan.runId).lockRemoved, true);
  fs.rmSync(root, { recursive: true, force: true });
});
