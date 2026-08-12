import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createContract, sha256 } from '../../plugins/bounded/runtime/src/contract.mjs';
import { verifyAcceptance, verifyArtifacts } from '../../plugins/bounded/runtime/src/verifier.mjs';

function contract() {
  return createContract({
    cwd: '/tmp/project', clientId: 'client', sessionId: 'session', toolCallId: 'call',
    trigger: { id: 'manual', value: 'test' }, task: { id: 'task', value: 'test' },
    acceptanceCheck: { id: 'check', value: 'out.txt contains ok' }, boundedContext: { sessionPath: 'session.json', readPaths: [], maxBytes: 10 },
    writeScope: { paths: ['out.txt'], patchPaths: [], maxFiles: 1 }, verifier: { id: 'bounded-runtime-verifier', digest: 'sha256:6b4dd88cfd35f757be313b6d40a7644a793f7706a7b5308a3b1a251a61f9a73d' },
    worker: { command: process.execPath, args: ['-e', ''] }, requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: { maxReadBytes: 10, maxArtifactBytes: 10, maxOutputBytes: 10, maxRequests: 2, maxWorkers: 1 },
    delivery: { mode: 'local', outputPaths: ['out.txt'], receiptPath: 'receipt' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 }, stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    trustedStateDigest: `sha256:${'b'.repeat(64)}`, maxSeconds: 1,
  }, { now: '2026-08-11T12:00:00.000Z' });
}

test('verifier accepts only declared outputs with matching bytes and digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-verifier-'));
  const value = Buffer.from('ok');
  fs.writeFileSync(path.join(root, 'out.txt'), value);
  const result = verifyArtifacts(contract(), root, [{ path: 'out.txt', bytes: value.length, digest: sha256(value) }]);
  assert.equal(result.valid, true);
  fs.writeFileSync(path.join(root, 'extra.txt'), 'no');
  assert.equal(verifyArtifacts(contract(), root, result.artifacts).valid, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime acceptance verification binds the check and artifact content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-verifier-'));
  fs.writeFileSync(path.join(root, 'out.txt'), 'ok\n');
  const value = contract();
  assert.equal(verifyAcceptance(value, root, { passed: true, digest: value.acceptanceCheck.digest }).valid, true);
  assert.equal(verifyAcceptance(value, root, { passed: true, digest: sha256('other') }).valid, false);
  fs.writeFileSync(path.join(root, 'out.txt'), 'BAD\n');
  assert.equal(verifyAcceptance(value, root, { passed: true, digest: value.acceptanceCheck.digest }).valid, false);
  fs.rmSync(root, { recursive: true, force: true });
});
