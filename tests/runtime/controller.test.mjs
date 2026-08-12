import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeController } from '../../plugins/bounded/runtime/src/controller.mjs';
import { sha256 } from '../../plugins/bounded/runtime/src/contract.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function request(cwd, script, overrides = {}) {
  return {
    cwd, clientId: 'codex-client-1', sessionId: 'session-1', toolCallId: `tool-${Math.random().toString(16).slice(2)}`,
    trigger: { id: 'manual', value: 'operator request' }, task: { id: 'task', value: 'write output' },
    acceptanceCheck: { id: 'files', value: 'output.txt contains ok' },
    boundedContext: { sessionPath: 'input.txt', readPaths: ['input.txt'], maxBytes: 1024 },
    writeScope: { paths: ['output.txt'], patchPaths: [], maxFiles: 1 },
    verifier: { id: 'bounded-runtime-verifier', digest: 'sha256:6b4dd88cfd35f757be313b6d40a7644a793f7706a7b5308a3b1a251a61f9a73d' }, worker: { command: process.execPath, args: ['-e', script] },
    requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: { maxReadBytes: 1024, maxArtifactBytes: 1024, maxOutputBytes: 1024, maxRequests: 2, maxWorkers: 1 },
    delivery: { mode: 'local', outputPaths: ['output.txt'], receiptPath: 'receipts/pending' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local/node'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 }, stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    trustedStateDigest: DIGEST, maxSeconds: 30, ...overrides,
  };
}

async function waitFor(controller, runId, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await controller.status(runId);
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${runId}`);
}

test('owns plan, approval, activation, verification, delivery, and terminal receipt', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-controller-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-state-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'baseline\n', { mode: 0o600 });
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); });
  const controller = createRuntimeController({ stateRoot });
  const contract = await controller.plan(request(cwd, "require('fs').writeFileSync('/workspace/output.txt','ok\\n')"));
  assert.equal((await controller.approve(contract.runId, {
    clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest,
    operatorProof: 'operator-confirmed', counter: 1,
  })).status, 'approved');
  const running = await controller.activate(contract.runId, {
    clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, counter: 2,
  });
  assert.equal(running.status, 'running');
  const ready = await waitFor(controller, contract.runId, (status) => status.workerStatus === 'ready');
  assert.equal(ready.active, true);
  const completed = await controller.complete(contract.runId, {
    clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest,
    leaseId: running.leaseId, counter: 3, acceptance: { passed: true, digest: sha256(contract.acceptanceCheck.value) },
  });
  assert.equal(completed.status, 'completed');
  assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8'), 'ok\n');
  assert.equal(completed.receipt.valid, true);
  assert.deepEqual(await controller.status(contract.runId), await controller.status(contract.runId));
  const backup = path.join(stateRoot, `${contract.runId}.backup-recovery`);
  fs.writeFileSync(backup, 'baseline\n', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'crash-delivered\n', { mode: 0o600 });
  fs.writeFileSync(path.join(stateRoot, `${contract.runId}.delivery`), `${JSON.stringify({
    schema: 'bounded-runtime-delivery/v1', runId: contract.runId,
    items: [{ relative: 'output.txt', target: path.join(cwd, 'output.txt'), backup, hadOriginal: true }], receipt: completed.receipt,
  })}\n`, { mode: 0o600 });
  await controller.reconcile();
  assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8'), 'crash-delivered\n');
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(path.join(stateRoot, `${contract.runId}.delivery`)), false);
  assert.equal((await controller.rollback(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, leaseId: running.leaseId, counter: 4, reason: 'late rollback' })).status, 'completed');
});

test('fails closed and rolls back when the worker fails or acceptance rejects', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-controller-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-state-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'baseline\n', { mode: 0o600 });
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); });
  const controller = createRuntimeController({ stateRoot });
  const contract = await controller.plan(request(cwd, "require('fs').writeFileSync('/workspace/output.txt','changed') ; process.exit(1)"));
  await controller.approve(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, operatorProof: 'operator-confirmed', counter: 1 });
  await controller.activate(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, counter: 2 });
  const failed = await waitFor(controller, contract.runId, (status) => ['failed', 'rolled-back'].includes(status.status));
  assert.equal(failed.status, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8'), 'baseline\n');
});

test('does not complete an artifact that fails the contract acceptance check', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-controller-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-state-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'baseline\n', { mode: 0o600 });
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); });
  const controller = createRuntimeController({ stateRoot });
  const contract = await controller.plan(request(cwd, "require('fs').writeFileSync('/workspace/output.txt','BAD')"));
  await controller.approve(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, operatorProof: 'operator-confirmed', counter: 1 });
  const running = await controller.activate(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, counter: 2 });
  await waitFor(controller, contract.runId, (status) => status.workerStatus === 'ready');
  const completed = await controller.complete(contract.runId, {
    clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest,
    leaseId: running.leaseId, counter: 3, acceptance: { passed: true, digest: sha256(contract.acceptanceCheck.value) },
  });
  assert.equal(completed.status, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8'), 'baseline\n');
});

test('rejects delivery through a symlinked project root', async (t) => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-real-'));
  const cwd = path.join(os.tmpdir(), `bounded-runtime-link-${process.pid}-${Date.now()}`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-state-'));
  fs.symlinkSync(real, cwd);
  fs.writeFileSync(path.join(real, 'output.txt'), 'baseline\n', { mode: 0o600 });
  t.after(() => { fs.rmSync(cwd, { force: true }); fs.rmSync(real, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); });
  const controller = createRuntimeController({ stateRoot });
  const plan = controller.plan(request(cwd, "require('fs').writeFileSync('/workspace/output.txt','ok')", {
    boundedContext: { sessionPath: 'input.txt', readPaths: [], maxBytes: 1024 },
  }));
  await assert.rejects(plan, /delivery root|unsafe/i);
  assert.equal(fs.readFileSync(path.join(real, 'output.txt'), 'utf8'), 'baseline\n');
});

test('detects project drift from the activation baseline and restores it on rollback', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-controller-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-state-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'baseline\n', { mode: 0o600 });
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); });
  const controller = createRuntimeController({ stateRoot });
  const contract = await controller.plan(request(cwd, "require('fs').writeFileSync('/workspace/output.txt','ok')"));
  await controller.approve(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, operatorProof: 'operator-confirmed', counter: 1 });
  const running = await controller.activate(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, counter: 2 });
  await waitFor(controller, contract.runId, (status) => status.workerStatus === 'ready');
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'drifted\n', { mode: 0o600 });
  const result = await controller.complete(contract.runId, {
    clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest,
    leaseId: running.leaseId, counter: 3, acceptance: { passed: true, digest: sha256(contract.acceptanceCheck.value) },
  });
  assert.equal(result.status, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8'), 'baseline\n');
});

test('preserves declared worker output for review instead of rolling it back', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-controller-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-state-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'baseline\n', { mode: 0o600 });
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); });
  const controller = createRuntimeController({ stateRoot });
  const contract = await controller.plan(request(cwd, "require('fs').writeFileSync('/workspace/output.txt','draft') ; process.exit(1)", {
    stopPolicy: { onFailure: 'preserve-for-review', partialSuccess: 'block' },
  }));
  await controller.approve(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, operatorProof: 'operator-confirmed', counter: 1 });
  await controller.activate(contract.runId, { clientId: contract.clientId, sessionId: contract.sessionId, contractDigest: contract.digest, counter: 2 });
  const preserved = await waitFor(controller, contract.runId, (status) => status.status === 'preserved');
  const preservedFile = path.join(stateRoot, 'preserved', contract.runId, 'output.txt');
  assert.equal(preserved.status, 'preserved');
  assert.equal(preserved.receipt.result, 'preserved');
  assert.equal(preserved.receipt.valid, true);
  assert.equal(preserved.preservedPath, path.dirname(preservedFile));
  assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8'), 'baseline\n');
  assert.equal(fs.readFileSync(preservedFile, 'utf8'), 'draft');
  assert.equal(fs.existsSync(path.join(stateRoot, `${contract.runId}.lease`)), false);
});
