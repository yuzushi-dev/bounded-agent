import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = path.resolve(new URL('../../plugins/bounded/', import.meta.url).pathname);

function run(node, cli, args, { cwd, root }) {
  return spawnSync(node, [cli, ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, BOUNDED_STATE_ROOT: root, PLUGIN_DATA: root, OMP_PATH: '', OMP_ROOT: '', OMP_HARNESS_DIR: '' },
  });
}

function stop(root) {
  const pidFile = path.join(root, 'runtime.pid');
  if (!fs.existsSync(pidFile)) return;
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {}
}

test('copied plugin runtime works without OMP files, variables, or processes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-independent-'));
  const plugin = path.join(root, 'plugin');
  const state = path.join(root, 'state');
  const project = path.join(root, 'project');
  fs.cpSync(source, plugin, { recursive: true });
  fs.mkdirSync(project, { mode: 0o700 });
  t.after(() => { stop(state); fs.rmSync(root, { recursive: true, force: true }); });
  const cli = path.join(plugin, 'bin', 'bounded.mjs');
  const doctor = run(process.execPath, cli, ['doctor', '--state-root', state], { cwd: project, root: state });
  assert.equal(doctor.status, 0, doctor.stderr);
  const contractPath = path.join(state, 'contract.json');
  const common = ['--cwd', project, '--task', 'bounded fixture', '--acceptance', 'inspect output', '--scope', 'output.txt', '--max-seconds', '30', '--max-read-bytes', '1024', '--max-artifact-bytes', '1024', '--max-output-bytes', '1024', '--max-requests', '2', '--prohibited-effects', 'all external effects', '--final-gate', 'human-approval', '--output', contractPath];
  const plan = run(process.execPath, cli, ['plan', ...common], { cwd: project, root: state });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(run(process.execPath, cli, ['approve', '--contract', contractPath, '--state-root', state], { cwd: project, root: state }).status, 0);
  assert.equal(run(process.execPath, cli, ['activate', '--contract', contractPath, '--state-root', state], { cwd: project, root: state }).status, 0);
  assert.equal(run(process.execPath, cli, ['status', '--contract', contractPath, '--state-root', state], { cwd: project, root: state }).status, 0);
  const rollback = run(process.execPath, cli, ['rollback', '--contract', contractPath, '--state-root', state], { cwd: project, root: state });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(JSON.parse(rollback.stdout).status, 'rolled-back');
});
