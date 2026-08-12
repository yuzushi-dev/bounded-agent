import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const pluginRoot = path.resolve(new URL('../../plugins/bounded/', import.meta.url).pathname);
const cli = path.join(pluginRoot, 'bin', 'bounded.mjs');
const hook = path.resolve(new URL('../../adapters/claude/hooks/bounded-hook.mjs', import.meta.url).pathname);

function run(args, { stateRoot, cwd }) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: stateRoot, BOUNDED_STATE_ROOT: stateRoot },
  });
}

function hookRun(input, { stateRoot, cwd }) {
  const result = spawnSync(process.execPath, [hook], {
    cwd, input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, HOME: stateRoot, BOUNDED_STATE_ROOT: stateRoot, BOUNDED_BIN: cli },
  });
  assert.equal(result.status, 0, `${result.stderr} stdout=${result.stdout}`);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}

function stop(stateRoot) {
  const pid = path.join(stateRoot, 'runtime.pid');
  if (fs.existsSync(pid)) {
    try { process.kill(Number(fs.readFileSync(pid, 'utf8')), 'SIGTERM'); } catch {}
  }
}

function activate(stateRoot, cwd) {
  const contractPath = path.join(stateRoot, 'contract.json');
  const args = ['plan', '--cwd', cwd, '--task', 'bounded task', '--acceptance', 'inspect output', '--scope', 'output.txt',
    '--max-seconds', '30', '--max-read-bytes', '1024', '--max-artifact-bytes', '1024', '--max-output-bytes', '1024',
    '--max-requests', '2', '--prohibited-effects', 'all external effects', '--final-gate', 'human-approval', '--output', contractPath];
  assert.equal(run(args, { stateRoot, cwd }).status, 0);
  assert.equal(run(['approve', '--contract', contractPath], { stateRoot, cwd }).status, 0);
  assert.equal(run(['activate', '--contract', contractPath], { stateRoot, cwd }).status, 0);
  return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
}

test('Claude hook exposes active context and denies external or stale-session tools', (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-claude-state-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-claude-project-'));
  t.after(() => { stop(stateRoot); fs.rmSync(stateRoot, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  const contract = activate(stateRoot, cwd);
  const started = hookRun({ hook_event_name: 'SessionStart', cwd, session_id: contract.sessionId }, { stateRoot, cwd });
  assert.match(started.hookSpecificOutput.additionalContext, /runtime active/i);
  const external = hookRun({ hook_event_name: 'PreToolUse', cwd, session_id: contract.sessionId, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, { stateRoot, cwd });
  assert.equal(external.hookSpecificOutput.permissionDecision, 'deny');
  const stale = hookRun({ hook_event_name: 'PreToolUse', cwd, session_id: 'other', tool_name: 'Read', tool_input: { path: 'output.txt' } }, { stateRoot, cwd });
  assert.equal(stale.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(['rollback', '--contract', path.join(stateRoot, 'contract.json')], { stateRoot, cwd }).status, 0);
});

test('Claude hook stays inert outside an active run but reserves lifecycle commands', (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-claude-inert-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-claude-project-'));
  t.after(() => { stop(stateRoot); fs.rmSync(stateRoot, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  assert.equal(hookRun({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Read', tool_input: { path: 'file.txt' } }, { stateRoot, cwd }), undefined);
  const lifecycle = hookRun({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'node bounded.mjs activate --contract contract.json' } }, { stateRoot, cwd });
  assert.equal(lifecycle.hookSpecificOutput.permissionDecision, 'deny');
});
