import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSION } from '../../plugins/bounded/runtime/src/protocol.mjs';
import { sha256 } from '../../plugins/bounded/runtime/src/contract.mjs';

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/bounded/runtime/bin/bounded-runtime.mjs');
const DIGEST = `sha256:${'a'.repeat(64)}`;

function fixture(cwd) {
  return {
    cwd, clientId: 'codex-client-1', sessionId: 'session-1', toolCallId: `tool-${Date.now()}`,
    trigger: { id: 'manual', value: 'operator request' }, task: { id: 'task', value: 'write output' },
    acceptanceCheck: { id: 'files', value: 'output.txt contains ok' },
    boundedContext: { sessionPath: 'input.txt', readPaths: ['input.txt'], maxBytes: 1024 },
    writeScope: { paths: ['output.txt'], patchPaths: [], maxFiles: 1 },
    verifier: { id: 'bounded-runtime-verifier', digest: 'sha256:6b4dd88cfd35f757be313b6d40a7644a793f7706a7b5308a3b1a251a61f9a73d' }, worker: { command: process.execPath, args: ['-e', "require('fs').writeFileSync('/workspace/output.txt','ok')"] },
    requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: { maxReadBytes: 1024, maxArtifactBytes: 1024, maxOutputBytes: 1024, maxRequests: 2, maxWorkers: 1 },
    delivery: { mode: 'local', outputPaths: ['output.txt'], receiptPath: 'receipts/pending' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local/node'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 }, stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    trustedStateDigest: DIGEST, maxSeconds: 30,
  };
}

function rpc(socket, frame) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      socket.off('data', onData);
      try { resolve(JSON.parse(buffer.slice(0, index))); } catch (error) { reject(error); }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(`${JSON.stringify(frame)}\n`);
  });
}

async function connect(socketPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const value = net.createConnection(socketPath);
        value.once('connect', () => resolve(value));
        value.once('error', reject);
      });
      return socket;
    } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error('runtime socket did not start');
}

test('runtime process survives client disconnect and owns the active run', { timeout: 30_000 }, async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-process-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-project-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'baseline\n', { mode: 0o600 });
  const child = spawn(process.execPath, [runtime, 'serve', '--state-root', stateRoot], {
    env: { PATH: process.env.PATH, HOME: path.join(stateRoot, 'home'), OMP_PATH: '', OMP_ROOT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(stateRoot, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  const socketPath = path.join(stateRoot, 'runtime.sock');
  const planSocket = await connect(socketPath);
  const base = { version: PROTOCOL_VERSION, clientId: 'codex-client-1' };
  const planned = await rpc(planSocket, { ...base, id: 'plan', method: 'plan', params: fixture(cwd) });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const contract = planned.result;
  const approved = await rpc(planSocket, { ...base, id: 'approve', method: 'approve', params: {
    runId: contract.runId, contractDigest: contract.digest, clientId: contract.clientId, sessionId: contract.sessionId,
    operatorProof: 'operator-confirmed', counter: 1,
  } });
  assert.equal(approved.result.status, 'approved');
  const activated = await rpc(planSocket, { ...base, id: 'activate', method: 'activate', params: {
    runId: contract.runId, contractDigest: contract.digest, clientId: contract.clientId, sessionId: contract.sessionId, counter: 2,
  } });
  assert.equal(activated.result.status, 'running');
  planSocket.destroy();
  const statusSocket = await connect(socketPath);
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await rpc(statusSocket, { ...base, id: `status-${attempt}`, method: 'status', params: { runId: contract.runId } });
    if (status.result.workerStatus === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status.result.workerStatus, 'ready', JSON.stringify(status));
  const completed = await rpc(statusSocket, { ...base, id: 'complete', method: 'complete', params: {
    runId: contract.runId, contractDigest: contract.digest, clientId: contract.clientId, sessionId: contract.sessionId,
    leaseId: activated.result.leaseId, counter: 3, acceptance: { passed: true, digest: sha256(contract.acceptanceCheck.value) },
  } });
  assert.equal(completed.result.status, 'completed', JSON.stringify(completed));
  assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8'), 'ok');
});

test('external guard preserves a pending run after runtime death when requested', { timeout: 30_000 }, async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-guard-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-project-'));
  fs.writeFileSync(path.join(cwd, 'input.txt'), 'input\n', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, 'output.txt'), 'baseline\n', { mode: 0o600 });
  const child = spawn(process.execPath, [runtime, 'serve', '--state-root', stateRoot], {
    env: { PATH: process.env.PATH, HOME: path.join(stateRoot, 'home') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(stateRoot, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  const socketPath = path.join(stateRoot, 'runtime.sock');
  const socket = await connect(socketPath);
  const base = { version: PROTOCOL_VERSION, clientId: 'codex-client-1' };
  const planned = await rpc(socket, { ...base, id: 'plan', method: 'plan', params: fixture(cwd) });
  const contract = planned.result;
  await rpc(socket, { ...base, id: 'approve', method: 'approve', params: {
    runId: contract.runId, contractDigest: contract.digest, clientId: contract.clientId, sessionId: contract.sessionId,
    operatorProof: 'operator-confirmed', counter: 1,
  } });
  const longWorker = fixture(cwd);
  longWorker.toolCallId = `tool-long-${Date.now()}`;
  longWorker.worker = { command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] };
  longWorker.stopPolicy = { onFailure: 'preserve-for-review', partialSuccess: 'block' };
  const second = await rpc(socket, { ...base, id: 'plan-long', method: 'plan', params: longWorker });
  const pending = second.result;
  await rpc(socket, { ...base, id: 'approve-long', method: 'approve', params: {
    runId: pending.runId, contractDigest: pending.digest, clientId: pending.clientId, sessionId: pending.sessionId,
    operatorProof: 'operator-confirmed', counter: 1,
  } });
  const activated = await rpc(socket, { ...base, id: 'activate-long', method: 'activate', params: {
    runId: pending.runId, contractDigest: pending.digest, clientId: pending.clientId, sessionId: pending.sessionId, counter: 2,
  } });
  assert.equal(activated.result.status, 'running');
  const lease = JSON.parse(fs.readFileSync(path.join(stateRoot, `${pending.runId}.lease`), 'utf8'));
  assert.equal(Number.isSafeInteger(lease.workerPid), true);
  assert.equal(typeof lease.workerStartTime, 'string');
  const guardWhileRuntimeAlive = spawn(process.execPath, [runtime, 'guard', '--state-root', stateRoot]);
  await new Promise((resolve, reject) => {
    guardWhileRuntimeAlive.once('error', reject);
    guardWhileRuntimeAlive.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`guard exited ${code}`)));
  });
  const healthy = JSON.parse(fs.readFileSync(path.join(stateRoot, `${pending.runId}.state`), 'utf8'));
  assert.equal(healthy.status, 'running');
  socket.destroy();
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  const guard = spawn(process.execPath, [runtime, 'guard', '--state-root', stateRoot], { encoding: 'utf8' });
  const result = await new Promise((resolve) => {
    let stdout = '';
    guard.stdout.on('data', (chunk) => { stdout += chunk; });
    guard.once('exit', (code) => resolve({ code, stdout }));
  });
  assert.equal(result.code, 0, result.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(stateRoot, `${pending.runId}.state`), 'utf8'));
  assert.equal(state.status, 'preserved');
  assert.equal(fs.existsSync(path.join(stateRoot, `${pending.runId}.lease`)), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8'), 'baseline\n');
  assert.equal(fs.existsSync(path.join(stateRoot, 'preserved', pending.runId, 'output.txt')), true);
});
