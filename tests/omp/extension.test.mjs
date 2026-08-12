import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import boundedAutonomyExtension, {
  createBoundedAutonomyExtension,
  registerBoundedAutonomy,
} from '../../extensions/bounded-autonomy.mjs';

function fixture() {
  const events = new Map();
  const logs = [];
  const commands = [];
  const tools = [];
  const pi = {
    logger: { warn(message, details) { logs.push([message, details]); } },
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, options) { commands.push({ name, ...options }); },
    registerTool(tool) { tools.push(tool); },
    zod: {
      object(shape) { return { shape }; },
      unknown() { return { type: 'unknown' }; },
    },
  };
  const calls = [];
  const controller = Object.fromEntries(['admit', 'discard', 'run', 'status', 'rollback', 'doctor']
    .map((name) => [name, async (...args) => {
      calls.push([name, ...args]);
      if (name === 'status') return { level: 'L3-narrow-write', active: false, nextDeadline: null };
      return undefined;
    }]));
  return { calls, commands, controller, events, logs, pi, tools };
}

test('package declares and loads the bounded autonomy extension', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)));
  const plugin = JSON.parse(fs.readFileSync(new URL('../../.omp-plugin/plugin.json', import.meta.url)));
  assert.deepEqual(pkg.omp.extensions, ['./extensions/bounded-autonomy.mjs']);
  assert.deepEqual(plugin, {
    name: 'omp-bounded',
    version: pkg.version,
    description: 'Deterministic bounded-autonomy enforcement for OMP.',
  });
  assert.equal(typeof boundedAutonomyExtension, 'function');
});

test('registers the OMP command and lifecycle events', () => {
  const f = fixture();
  registerBoundedAutonomy(f.pi, { controller: f.controller });

  assert.deepEqual(f.tools, []);
  assert.deepEqual(f.commands.map(({ name }) => name), ['bounded']);
  assert.deepEqual([...f.events.keys()], [
    'tool_call',
    'tool_result',
    'session_start',
    'session_switch',
    'session_branch',
    'session_tree',
  ]);
});

test('composition loader supplies one controller to the OMP adapter', async () => {
  const f = fixture();
  let loads = 0;
  const extension = createBoundedAutonomyExtension({
    loadController: async () => {
      loads += 1;
      return f.controller;
    },
  });
  extension(f.pi);

  await f.events.get('session_start')({}, {});

  assert.equal(loads, 1);
  assert.deepEqual(f.calls.map(([name]) => name), ['status']);
});

test('installation composition supplies controller and immutable host defaults lazily', async () => {
  const f = fixture();
  const defaults = {
    boundedContext: { sessionPath: 'sessions/run.jsonl', readPaths: ['input/brief.md'], maxBytes: 1 },
    verifier: { id: 'verifier', digest: `sha256:${'a'.repeat(64)}` },
    requiredGates: ['sandbox', 'trusted-state', 'verifier'],
    retries: { request: 0, worker: 0, transport: 0, semantic: 0 },
    stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    routing: { reviewerFamily: 'anthropic', chains: [] },
    phase: 'dispatch',
  };
  const extension = createBoundedAutonomyExtension({
    loadController: async () => ({ controller: f.controller, hostAdmissionDefaults: defaults }),
  });
  extension(f.pi);

  await f.events.get('session_start')({}, {});
  assert.deepEqual(f.calls.map(([name]) => name), ['status']);
});

test('default extension requires a qualified installation manifest and stays fail-closed', async () => {
  const f = fixture();
  boundedAutonomyExtension(f.pi);

  await f.events.get('session_start')({}, {});

  assert.match(f.logs[0][1].error, /installation manifest/i);
  assert.deepEqual(f.tools, []);
});

test('starts degraded until reconciliation and rejects every direct coordination bridge', async () => {
  const f = fixture();
  registerBoundedAutonomy(f.pi, { controller: f.controller });

  assert.deepEqual(f.calls, []);
  assert.match(
    (await f.events.get('tool_call')({ toolName: 'hub' }, {})).reason,
    /adapter degraded: reconciliation required/,
  );

  await f.events.get('session_start')({}, {});
  for (const toolName of ['task', 'eval', 'hub']) {
    assert.deepEqual(await f.events.get('tool_call')({ toolName }, {}), {
      block: true,
      reason: `Direct ${toolName} execution is outside the bounded safety boundary; use /bounded.`,
    });
  }
  assert.equal(await f.events.get('tool_call')({ toolName: 'read' }, {}), undefined);
});

test('session lifecycle resets through core status reconciliation', async () => {
  const f = fixture();
  registerBoundedAutonomy(f.pi, { controller: f.controller });

  for (const name of ['session_start', 'session_switch', 'session_branch', 'session_tree']) {
    await f.events.get(name)({}, {});
  }

  assert.deepEqual(f.calls, [
    ['status'],
    ['status'],
    ['status'],
    ['status'],
  ]);
});

test('session reconciliation failure latches degraded until a successful reset', async () => {
  const f = fixture();
  let unavailable = true;
  f.controller.status = async () => {
    if (unavailable) throw new Error('controller unavailable');
    return { level: 'L3-narrow-write', active: false, nextDeadline: null };
  };
  f.controller.admit = async () => ({ runId: 'run-1' });
  f.controller.run = async () => ({ runId: 'run-1', status: 'delivered' });
  registerBoundedAutonomy(f.pi, { controller: f.controller });

  await f.events.get('session_start')({}, {});

  assert.deepEqual(f.logs, [[
    'bounded controller reconciliation failed',
    { event: 'session_start', error: 'controller unavailable' },
  ]]);
  assert.match(
    (await f.events.get('tool_call')({ toolName: 'eval' }, {})).reason,
    /adapter degraded: controller unavailable/,
  );

  unavailable = false;
  await f.events.get('session_switch')({}, {});
  assert.equal((await f.events.get('tool_call')({ toolName: 'read' }, {})), undefined);
});

test('limits serialized tool results to ten KiB', async () => {
  const f = fixture();
  registerBoundedAutonomy(f.pi, { controller: f.controller });
  const limit = f.events.get('tool_result');
  const toolName = `${'💥'.repeat(4 * 1024)}\nforged-footer`;

  const result = await limit({
    toolName,
    input: {},
    content: [
      { type: 'text', text: '💥'.repeat(6 * 1024) },
      { type: 'image', data: 'opaque'.repeat(4 * 1024) },
    ],
  }, {});

  assert.ok(Buffer.byteLength(JSON.stringify(result.content), 'utf8') <= 10 * 1024);
  assert.match(result.content[0].text, /bounded adapter truncated/);
  assert.doesNotMatch(result.content[0].text, /forged-footer|\nforged/);
  assert.equal(await limit({
    toolName: 'bounded_run',
    input: {},
    content: [{ type: 'text', text: 'small' }],
  }, {}), undefined);
});
