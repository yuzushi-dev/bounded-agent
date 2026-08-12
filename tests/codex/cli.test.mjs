import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const cli = path.resolve(new URL('../../plugins/bounded/bin/bounded.mjs', import.meta.url).pathname);
const packageRoot = path.resolve(new URL('../../plugins/bounded/', import.meta.url).pathname);

function run(args, { cwd, root }) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, BOUNDED_STATE_ROOT: root, PLUGIN_DATA: root, PLUGIN_ROOT: packageRoot },
  });
}

function stopRuntime(root) {
  const file = path.join(root, 'runtime.pid');
  if (!fs.existsSync(file)) return;
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (Number.isSafeInteger(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
}

test('uses the runtime protocol for plan, approval, activation, status, and rollback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-cli-runtime-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-cli-project-'));
  const contractPath = path.join(root, 'contract.json');
  t.after(() => { stopRuntime(root); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });

  const args = [
    '--cwd', cwd, '--task', 'update one file', '--acceptance', 'inspect output externally', '--scope', 'output.txt',
    '--max-seconds', '30', '--max-read-bytes', '4096', '--max-artifact-bytes', '4096', '--max-output-bytes', '4096',
    '--max-requests', '2', '--prohibited-effects', 'all external effects', '--final-gate', 'human-approval',
    '--output', contractPath,
  ];
  const plan = run(['plan', ...args], { cwd, root });
  assert.equal(plan.status, 0, plan.stderr);
  const contract = JSON.parse(plan.stdout);
  assert.equal(contract.schema, 'bounded-runtime-contract/v1');
  assert.equal(JSON.parse(fs.readFileSync(contractPath, 'utf8')).digest, contract.digest);

  const approval = run(['approve', '--contract', contractPath], { cwd, root });
  assert.equal(approval.status, 0, approval.stderr);
  const active = run(['activate', '--contract', contractPath], { cwd, root });
  assert.equal(active.status, 0, active.stderr);
  assert.equal(JSON.parse(active.stdout).status, 'running');
  const status = run(['status', '--contract', contractPath], { cwd, root });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).active, true, `${status.stdout}${status.stderr}`);
  const rollback = run(['rollback', '--contract', contractPath], { cwd, root });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(JSON.parse(rollback.stdout).status, 'rolled-back');
});

test('rejects incomplete plans and refuses to overwrite contract output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-cli-invalid-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-cli-project-'));
  const output = path.join(root, 'contract.json');
  fs.writeFileSync(output, 'keep-me\n', { mode: 0o600 });
  t.after(() => { stopRuntime(root); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  const incomplete = run(['plan', '--cwd', cwd, '--task', 'missing fields'], { cwd, root });
  assert.notEqual(incomplete.status, 0);
  const overwrite = run(['plan', '--cwd', cwd, '--task', 'task', '--acceptance', 'check', '--scope', 'out.txt', '--max-seconds', '30', '--max-read-bytes', '1', '--max-artifact-bytes', '1', '--max-output-bytes', '1', '--max-requests', '2', '--prohibited-effects', 'all external effects', '--final-gate', 'human-approval', '--output', output], { cwd, root });
  assert.notEqual(overwrite.status, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep-me\n');
});

test('plans an explicit preserve-for-review failure policy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-cli-preserve-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-cli-project-'));
  const output = path.join(root, 'contract.json');
  t.after(() => { stopRuntime(root); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  const result = run(['plan', '--cwd', cwd, '--task', 'keep reviewable work', '--acceptance', 'inspect output', '--scope', 'output.txt',
    '--max-seconds', '30', '--max-read-bytes', '1024', '--max-artifact-bytes', '1024', '--max-output-bytes', '1024', '--max-requests', '2',
    '--on-failure', 'preserve-for-review', '--output', output], { cwd, root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).stopPolicy.onFailure, 'preserve-for-review');
});

test('reports the active run bound to a project directory without a contract file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-cli-status-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-cli-project-'));
  t.after(() => { stopRuntime(root); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });

  const result = run(['status', '--cwd', cwd], { cwd, root });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.active, false);
  assert.equal(status.cwd, path.resolve(cwd));
});
