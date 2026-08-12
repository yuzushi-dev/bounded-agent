import assert from 'node:assert/strict';
import test from 'node:test';

import { createBoundedHook } from '../../adapters/omp-ohmy-pi/bounded-hook.mjs';

function fixture(status = { active: false }) {
  const events = new Map();
  const commands = [];
  const calls = [];
  const notifications = [];
  const hook = createBoundedHook({
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'status') return { stdout: `${JSON.stringify(status)}\n` };
      return { stdout: '{"status":"ready"}\n' };
    },
  });
  hook({
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, options) { commands.push({ name, ...options }); },
  });
  const ctx = {
    cwd: '/tmp/project',
    sessionManager: { getSessionId: () => 'session-1' },
    ui: { notify(value, type) { notifications.push([value, type]); } },
  };
  return { calls, commands, ctx, events, notifications };
}

test('OMP hook uses the installed CLI status seam and blocks direct coordination', async () => {
  const f = fixture({ active: true, sessionId: 'other-session' });
  assert.deepEqual(await f.events.get('tool_call')({ toolName: 'task', input: {} }, f.ctx), {
    block: true, reason: 'Direct coordination is outside bounded; use /bounded.',
  });
  assert.deepEqual(await f.events.get('tool_call')({ toolName: 'read', input: {} }, f.ctx), {
    block: true, reason: 'bounded runtime session does not match this OMP session',
  });
  await f.events.get('tool_result')({ toolName: 'read' }, f.ctx);
  assert.deepEqual(f.calls, [
    ['status', '--cwd', '/tmp/project'],
    ['status', '--cwd', '/tmp/project'],
  ]);
});

test('OMP hook exposes only advisory status for an inactive run and a CLI command', async () => {
  const f = fixture();
  assert.equal(await f.events.get('tool_call')({ toolName: 'read', input: {} }, f.ctx), undefined);
  await f.commands[0].handler('doctor', f.ctx);
  assert.deepEqual(f.notifications, [['{"status":"ready"}', 'info']]);
});

test('OMP hook fails closed for dispatch when the bounded CLI is unavailable', async () => {
  const f = fixture();
  f.events.set('tool_call', createBoundedHook({ run: async () => { throw new Error('missing bounded'); } }));
  const events = new Map();
  createBoundedHook({ run: async () => { throw new Error('missing bounded'); } })({
    on(name, handler) { events.set(name, handler); },
    registerCommand() {},
  });
  assert.deepEqual(await events.get('tool_call')({ toolName: 'task', input: {} }, f.ctx), {
    block: true, reason: 'Direct coordination is outside bounded; use /bounded.',
  });
  await assert.rejects(() => events.get('tool_call')({ toolName: 'read', input: {} }, f.ctx), /missing bounded/);
});
