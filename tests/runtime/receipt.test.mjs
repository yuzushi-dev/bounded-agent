import test from 'node:test';
import assert from 'node:assert/strict';

import { createContract, sha256 } from '../../plugins/bounded/runtime/src/contract.mjs';
import { createReceipt, verifyReceipt } from '../../plugins/bounded/runtime/src/receipt.mjs';
import { createInitialState } from '../../plugins/bounded/runtime/src/state.mjs';

const NOW = '2026-08-11T12:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function fixture({ stopPolicy = { onFailure: 'rollback', partialSuccess: 'block' } } = {}) {
  const contract = createContract({
    cwd: '/tmp/bounded-project', clientId: 'codex-client-1', sessionId: 'session-1', toolCallId: 'tool-call-1',
    trigger: { id: 'manual', value: 'operator request' }, task: { id: 'task', value: 'local bounded task' },
    acceptanceCheck: { id: 'tests', value: 'node --test test/index.test.mjs' },
    boundedContext: { sessionPath: 'context/session.json', readPaths: ['src/index.mjs'], maxBytes: 1024 },
    writeScope: { paths: ['src/index.mjs'], patchPaths: [], maxFiles: 1 },
    verifier: { id: 'bounded-runtime-verifier', digest: 'sha256:6b4dd88cfd35f757be313b6d40a7644a793f7706a7b5308a3b1a251a61f9a73d' }, worker: { command: process.execPath, args: ['-e', ''] },
    requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: { maxReadBytes: 1024, maxArtifactBytes: 1024, maxOutputBytes: 1024, maxRequests: 2, maxWorkers: 1 },
    delivery: { mode: 'local', outputPaths: ['src/index.mjs'], receiptPath: 'receipts/pending' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local/node'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 },
    stopPolicy, trustedStateDigest: DIGEST, maxSeconds: 30,
  }, { now: NOW });
  const state = createInitialState(contract, { now: NOW });
  state.status = 'running';
  state.counter = 2;
  state.leaseId = 'lease-1';
  return { contract, state };
}

test('creates and verifies a receipt bound to contract, run, lease, counters, and outputs', () => {
  const { contract, state } = fixture();
  const receipt = createReceipt({
    contract, state, leaseId: 'lease-1', result: 'completed',
    counters: { requests: 1, workers: 1, readBytes: 10, artifactBytes: 2, outputBytes: 4 },
    artifacts: [{ path: 'src/index.mjs', bytes: 2, digest: DIGEST }],
    acceptance: { passed: true, digest: sha256(contract.acceptanceCheck.value) }, completedAt: '2026-08-11T12:00:03.000Z',
  });

  assert.equal(verifyReceipt(receipt, { contract, runId: state.runId, leaseId: 'lease-1' }).valid, true);
  assert.equal(verifyReceipt({ ...receipt, leaseId: 'lease-2' }, { contract, runId: state.runId, leaseId: 'lease-1' }).valid, false);
  assert.equal(verifyReceipt({ ...receipt, counters: { ...receipt.counters, outputBytes: 5 } }, { contract, runId: state.runId, leaseId: 'lease-1' }).valid, false);
});

test('rejects receipts with undeclared outputs, failed acceptance, or budget overflow', () => {
  const { contract, state } = fixture();
  assert.throws(() => createReceipt({
    contract, state, leaseId: 'lease-1', result: 'completed',
    counters: { requests: 1, workers: 1, readBytes: 0, artifactBytes: 2, outputBytes: 0 },
    artifacts: [{ path: 'outside.txt', bytes: 2, digest: DIGEST }], acceptance: { passed: true, digest: sha256(contract.acceptanceCheck.value) },
    completedAt: '2026-08-11T12:00:03.000Z',
  }), /output|scope|artifact/i);
  assert.throws(() => createReceipt({
    contract, state, leaseId: 'lease-1', result: 'completed',
    counters: { requests: 1, workers: 1, readBytes: 0, artifactBytes: 2, outputBytes: 0 },
    artifacts: [{ path: 'src/index.mjs', bytes: 2, digest: DIGEST }], acceptance: { passed: false, digest: sha256(contract.acceptanceCheck.value) },
    completedAt: '2026-08-11T12:00:03.000Z',
  }), /acceptance|passed/i);
});

test('creates and verifies a preserved receipt without acceptance proof', () => {
  const { contract, state } = fixture({ stopPolicy: { onFailure: 'preserve-for-review', partialSuccess: 'block' } });
  const receipt = createReceipt({
    contract, state, leaseId: 'lease-1', result: 'preserved',
    counters: { requests: 1, workers: 1, readBytes: 0, artifactBytes: 2, outputBytes: 0 },
    artifacts: [{ path: 'src/index.mjs', bytes: 2, digest: DIGEST }], completedAt: '2026-08-11T12:00:03.000Z',
  });
  assert.equal(receipt.acceptance, null);
  assert.equal(verifyReceipt(receipt, { contract, runId: state.runId, leaseId: 'lease-1' }).valid, true);
});
