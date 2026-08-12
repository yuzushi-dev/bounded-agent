import test from 'node:test';
import assert from 'node:assert/strict';

import { createContract, validateContract } from '../../plugins/bounded/runtime/src/contract.mjs';

const NOW = '2026-08-11T12:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function request(overrides = {}) {
  return {
    cwd: '/tmp/bounded-project',
    clientId: 'codex-client-1',
    sessionId: 'session-1',
    toolCallId: 'tool-call-1',
    trigger: { id: 'manual', value: 'operator request' },
    task: { id: 'task', value: 'Update src/index.mjs' },
    acceptanceCheck: { id: 'tests', value: 'node --test test/index.test.mjs' },
    boundedContext: {
      sessionPath: 'context/session.json',
      readPaths: ['src/index.mjs', 'test/index.test.mjs'],
      maxBytes: 4096,
    },
    writeScope: {
      paths: ['src/index.mjs'],
      patchPaths: ['test/index.test.mjs'],
      maxFiles: 2,
    },
    verifier: { id: 'bounded-runtime-verifier', digest: 'sha256:6b4dd88cfd35f757be313b6d40a7644a793f7706a7b5308a3b1a251a61f9a73d' },
    worker: { command: process.execPath, args: ['-e', ''] },
    requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: {
      maxReadBytes: 4096,
      maxArtifactBytes: 4096,
      maxOutputBytes: 4096,
      maxRequests: 4,
      maxWorkers: 1,
    },
    delivery: { mode: 'local', outputPaths: ['src/index.mjs'], receiptPath: 'receipts/pending' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local/node'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 },
    stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    trustedStateDigest: DIGEST,
    maxSeconds: 30,
    ...overrides,
  };
}

test('creates an immutable plan bound to client, session, run, and digest', () => {
  const contract = createContract(request(), { now: NOW });

  assert.equal(contract.schema, 'bounded-runtime-contract/v1');
  assert.equal(contract.clientId, 'codex-client-1');
  assert.equal(contract.sessionId, 'session-1');
  assert.match(contract.runId, /^run_[a-f0-9]{24}$/);
  assert.match(contract.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(contract.delivery.receiptPath, `receipts/${contract.runId}.json`);
  assert.equal(validateContract(contract, { now: NOW }).valid, true);
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.writeScope), true);
});

test('rejects contract drift, stale deadlines, and missing identity gates', () => {
  const contract = createContract(request(), { now: NOW });

  assert.equal(validateContract({ ...contract, sessionId: 'other-session' }, { now: NOW }).valid, false);
  assert.equal(validateContract({ ...contract, clientId: 'other-client' }, { now: NOW }).valid, false);
  assert.equal(validateContract(contract, { now: new Date(Date.parse(NOW) + 30_001).toISOString() }).valid, false);
  assert.throws(() => createContract(request({ requiredGates: ['sandbox'] }), { now: NOW }), /gate/i);
});

test('rejects traversal, undeclared effects, and non-local delivery', () => {
  assert.throws(() => createContract(request({
    writeScope: { paths: ['../outside'], patchPaths: [], maxFiles: 1 },
  }), { now: NOW }), /path|scope/i);
  assert.throws(() => createContract(request({ externalEffects: { enabled: true } }), { now: NOW }), /effect/i);
  assert.throws(() => createContract(request({
    delivery: { mode: 'network', outputPaths: ['src/index.mjs'], receiptPath: 'receipts/pending' },
  }), { now: NOW }), /delivery|local|effect/i);
  assert.throws(() => createContract(request({
    boundedContext: { sessionPath: '.ssh/id_rsa', readPaths: ['.ssh/id_rsa'], maxBytes: 4096 },
  }), { now: NOW }), /context|path|sensitive/i);
  assert.throws(() => createContract(request({ worker: { command: '/usr/bin/curl', args: [] } }), { now: NOW }), /worker|external|command/i);
});

test('allows an explicit preserve-for-review failure policy and rejects unknown policies', () => {
  const preserved = createContract(request({ stopPolicy: { onFailure: 'preserve-for-review', partialSuccess: 'block' } }), { now: NOW });
  assert.equal(preserved.stopPolicy.onFailure, 'preserve-for-review');
  assert.equal(validateContract(preserved, { now: NOW }).valid, true);
  assert.throws(() => createContract(request({ stopPolicy: { onFailure: 'keep-everything', partialSuccess: 'block' } }), { now: NOW }), /stop-policy/i);
});
