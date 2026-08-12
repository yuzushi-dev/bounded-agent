import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const packageRoot = path.resolve(new URL('../../plugins/bounded/', import.meta.url).pathname);
const cli = path.join(packageRoot, 'bin', 'bounded.mjs');
const hook = path.join(packageRoot, 'hooks', 'bounded-hook.mjs');

function env(root) { return { PATH: process.env.PATH, HOME: root, BOUNDED_STATE_ROOT: root, PLUGIN_DATA: root, PLUGIN_ROOT: packageRoot }; }
function run(args, { root, cwd }) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: env(root) }); }
function hookRun(input, { root, cwd }) {
  const result = spawnSync(process.execPath, [hook], { cwd, input: JSON.stringify(input), encoding: 'utf8', env: env(root) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}
function stop(root) {
  const file = path.join(root, 'runtime.pid');
  if (!fs.existsSync(file)) return;
  try { process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGTERM'); } catch {}
}

function plan(root, cwd) {
  const output = path.join(root, 'contract.json');
  const result = run(['plan', '--cwd', cwd, '--task', 'bounded task', '--acceptance', 'inspect output', '--scope', 'output.txt', '--max-seconds', '30', '--max-read-bytes', '1024', '--max-artifact-bytes', '1024', '--max-output-bytes', '1024', '--max-requests', '2', '--prohibited-effects', 'all external effects', '--final-gate', 'human-approval', '--output', output], { root, cwd });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(run(['approve', '--contract', output], { root, cwd }).status, 0);
  assert.equal(run(['activate', '--contract', output], { root, cwd }).status, 0);
  return { contract, output };
}

test('reports runtime context and denies unsupported tool execution during an active run', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-hook-runtime-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-hook-project-'));
  t.after(() => { stop(root); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  const { contract, output } = plan(root, cwd);
  const started = hookRun({ hook_event_name: 'SessionStart', cwd, session_id: contract.sessionId }, { root, cwd });
  assert.match(started.hookSpecificOutput.additionalContext, /runtime active/i);
  const denied = hookRun({ hook_event_name: 'PreToolUse', cwd, session_id: contract.sessionId, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, { root, cwd });
  assert.ok(denied, 'hook did not return a decision');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /shell|external/i);
  const stale = hookRun({ hook_event_name: 'PreToolUse', cwd, session_id: 'other-session', tool_name: 'Read', tool_input: { path: 'output.txt' } }, { root, cwd });
  assert.equal(stale.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(stale.hookSpecificOutput.permissionDecisionReason, /session/i);
  assert.equal(run(['rollback', '--contract', output], { root, cwd }).status, 0);
});

test('stays inert outside an active run but reserves lifecycle commands to the terminal adapter', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-hook-inert-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-hook-project-'));
  t.after(() => { stop(root); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  assert.equal(hookRun({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Read', tool_input: { path: 'file.txt' } }, { root, cwd }), undefined);
  const lifecycle = hookRun({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'node bounded.mjs activate --contract contract.json' } }, { root, cwd });
  assert.equal(lifecycle.hookSpecificOutput.permissionDecision, 'deny');
});
