import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createContract } from '../../plugins/bounded/runtime/src/contract.mjs';
import { executeWorker } from '../../plugins/bounded/runtime/src/executor.mjs';

const NOW = new Date().toISOString();
const DIGEST = `sha256:${'a'.repeat(64)}`;

function contract(cwd, script, overrides = {}) {
  return createContract({
    cwd, clientId: 'codex-client-1', sessionId: 'session-1', toolCallId: 'tool-call-1',
    trigger: { id: 'manual', value: 'operator request' }, task: { id: 'task', value: 'write output' },
    acceptanceCheck: { id: 'files', value: 'output.txt contains ok' },
    boundedContext: { sessionPath: 'input.txt', readPaths: ['input.txt'], maxBytes: 1024 },
    writeScope: { paths: ['output.txt'], patchPaths: [], maxFiles: 1 },
    verifier: { id: 'bounded-runtime-verifier', digest: 'sha256:6b4dd88cfd35f757be313b6d40a7644a793f7706a7b5308a3b1a251a61f9a73d' }, worker: { command: process.execPath, args: ['-e', script] },
    requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: { maxReadBytes: 1024, maxArtifactBytes: 1024, maxOutputBytes: 128, maxRequests: 2, maxWorkers: 1 },
    delivery: { mode: 'local', outputPaths: ['output.txt'], receiptPath: 'receipts/pending' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local/node'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 }, stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    trustedStateDigest: DIGEST, maxSeconds: 2, ...overrides,
  }, { now: NOW });
}

test('runs a worker in a filesystem/network-contained stage and returns only declared artifacts', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-exec-'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-stage-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(stage, { recursive: true, force: true }); });
  const result = await executeWorker(contract(cwd, "require('fs').writeFileSync('/workspace/output.txt','ok')"), { stageRoot: stage });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.artifacts.map(({ path: value }) => value), ['output.txt']);
  assert.equal(fs.readFileSync(path.join(stage, 'output.txt'), 'utf8'), 'ok');
});

test('fails closed on undeclared writes, network access, output exhaustion, and deadline expiry', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-exec-'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-stage-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(stage, { recursive: true, force: true }); });
  const outside = await executeWorker(contract(cwd, "require('fs').writeFileSync('/workspace/undeclared.txt','x')"), { stageRoot: stage });
  assert.notEqual(outside.status, 'completed');
  const network = await executeWorker(contract(cwd, "require('net').createConnection(80,'127.0.0.1')"), { stageRoot: stage });
  assert.notEqual(network.status, 'completed');
  const noisy = await executeWorker(contract(cwd, "process.stdout.write('x'.repeat(1000))"), { stageRoot: stage });
  assert.equal(noisy.status, 'failed');
  const slow = await executeWorker(contract(cwd, 'setTimeout(()=>{},10000)', { maxSeconds: 1 }), { stageRoot: stage });
  assert.equal(slow.status, 'failed');
});

test('fails closed when a declared read path traverses an intermediate symlink', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-exec-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-outside-'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-stage-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(cwd, 'linked'));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  });
  const result = await executeWorker(contract(cwd, "require('fs').writeFileSync('/workspace/output.txt',require('fs').readFileSync('/workspace/linked/secret.txt'))", {
    boundedContext: { sessionPath: 'input.txt', readPaths: ['linked/secret.txt'], maxBytes: 1024 },
  }), { stageRoot: stage });
  assert.notEqual(result.status, 'completed', JSON.stringify(result));
});
