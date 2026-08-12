import assert from 'node:assert/strict';
import test from 'node:test';

import { createOmpAdapter } from '../../adapters/omp.mjs';
import { sha256, stableSerialize } from '../../core/receipt.mjs';

const HOST_DEFAULTS = {
  boundedContext: { sessionPath: 'sessions/run.jsonl', readPaths: ['input/brief.md'], maxBytes: 1024 },
  verifier: { id: 'independent-verifier', digest: `sha256:${'a'.repeat(64)}` },
  requiredGates: ['sandbox', 'trusted-state', 'verifier'],
  retries: { request: 0, worker: 0, transport: 0, semantic: 0 },
  stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
  routing: {
    reviewerFamily: 'anthropic',
    chains: [
      { role: 'task', family: 'openai-codex', selectors: ['openai-codex/gpt'] },
      { role: 'reviewer', family: 'anthropic', selectors: ['anthropic/claude'] },
    ],
  },
  phase: 'dispatch',
};

function fixture({ defaults = HOST_DEFAULTS, inputs = [], confirmed = true, overrides = {} } = {}) {
  const commands = [];
  const notifications = [];
  const confirmations = [];
  const calls = [];
  const trace = [];
  const events = new Map();
  const tools = [];
  const implementations = {
    async admit(request) {
      const createdAt = '2026-08-11T00:00:00.000Z';
      return {
        schema: 'omp-run-contract/v2', runId: 'run-1',
        task: { id: request.task.id, digest: sha256(request.task.value) },
        acceptanceCheck: { id: request.acceptanceCheck.id, digest: sha256(request.acceptanceCheck.value) },
        writeScope: structuredClone(request.writeScope), budgets: structuredClone(request.budgets),
        requiredGates: [...request.requiredGates, 'external-effects-disabled'],
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + request.maxSeconds * 1000).toISOString(),
      };
    },
    async run() { return { schema: 'omp-bounded-receipt/v1', runId: 'run-1', status: 'completed' }; },
    async discard(contract) { return { status: 'discarded', runId: contract.runId }; },
    async status() { return { level: 'L3-narrow-write', active: false, nextDeadline: null }; },
    async rollback(reason) { return { status: 'protected', reason }; },
    async doctor() { return { status: 'ready', failures: [] }; },
    ...overrides,
  };
  const controller = Object.fromEntries(Object.entries(implementations).map(([name, implementation]) => [
    name,
    async (...args) => { calls.push([name, ...args]); trace.push(name); return implementation(...args); },
  ]));
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerTool(tool) { tools.push(tool); },
    registerCommand(name, options) { commands.push({ name, ...options }); },
    zod: { object: (shape) => ({ shape }), unknown: () => ({}) },
  };
  createOmpAdapter(controller, { hostAdmissionDefaults: defaults }).register(pi);
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => 'session-1' },
    ui: {
      async input(title) { trace.push('input'); return inputs.shift(); },
      async confirm(title, message) { confirmations.push([title, message]); trace.push('confirm'); return confirmed; },
      notify(message, type) { notifications.push([message, type]); },
    },
  };
  return {
    calls, command: commands.find(({ name }) => name === 'bounded'), confirmations, controller, ctx,
    events, notifications, tools, trace,
    async reconcile() { await events.get('session_start')({}, ctx); calls.length = 0; trace.length = 0; },
  };
}

const COMPLETE_RUN = 'run --task "Update approval page" --acceptance "tests pass" --scope approval-console/index.html,approval-console/test_index.py --max-seconds 300 --max-read-bytes 4096 --max-artifact-bytes 2048 --max-output-bytes 1024 --max-requests 2 --prohibited-effects "all external effects" --final-gate human-approval';

test('registers /bounded as the sole execution entry point', () => {
  const f = fixture();
  assert.equal(f.command.description, 'Run and inspect deterministic bounded autonomy.');
  assert.deepEqual(f.tools, []);
  assert.deepEqual(f.calls, []);
});

test('/bounded confirms an exact canonical preview before timed admission, then runs and discards', async () => {
  const f = fixture();
  await f.reconcile();
  await f.command.handler(COMPLETE_RUN, f.ctx);

  const request = f.calls[0][1];
  const contract = f.calls[1][1];
  assert.deepEqual(f.calls.map(([name]) => name), ['admit', 'run', 'discard']);
  assert.deepEqual(f.trace, ['confirm', 'admit', 'run', 'discard']);
  assert.deepEqual(request.task, { id: 'bounded-command-task', value: 'Update approval page' });
  assert.deepEqual(request.acceptanceCheck, { id: 'bounded-command-acceptance', value: 'tests pass' });
  assert.deepEqual(request.writeScope.paths, ['approval-console/index.html', 'approval-console/test_index.py']);
  assert.deepEqual(request.routing, HOST_DEFAULTS.routing);
  assert.equal(request.sessionId, 'session-1');
  assert.equal(request.toolCallId, 'bounded-command-1');
  assert.equal(f.calls[1][2].signal instanceof AbortSignal, true);

  const view = JSON.parse(f.confirmations[0][1]);
  assert.equal(view.task, request.task.value);
  assert.equal(view.acceptance, request.acceptanceCheck.value);
  assert.deepEqual(view.scope, request.writeScope.paths);
  assert.deepEqual(view.budgets, request.budgets);
  assert.equal(view.maxSeconds, 300);
  assert.equal(view.prohibitedEffects, 'all external effects');
  assert.equal(view.finalGate, 'human-approval');
  assert.deepEqual(view.request, request);
  assert.equal(view.requestDigest, sha256(stableSerialize(request)));
  assert.deepEqual(JSON.parse(f.notifications[0][0]), {
    contract,
    contractDigest: sha256(stableSerialize(contract)),
  });
});

test('oversized exact confirmation is rejected and discarded instead of truncated', async () => {
  const f = fixture();
  await f.reconcile();
  await f.command.handler(COMPLETE_RUN.replace('tests pass', 'x'.repeat(12 * 1024)), f.ctx);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.confirmations, []);
  assert.match(f.notifications.at(-1)[0], /confirmation.*10 KiB/i);
});

test('/bounded run collects missing fields and treats input cancellation cleanly', async () => {
  const complete = fixture({ inputs: [
    'Exact outcome', 'Acceptance check', 'artifacts/result.txt', '60', '1024', '2048', '4096', '2',
    'all external effects', 'human-approval',
  ] });
  await complete.reconcile();
  await complete.command.handler('run', complete.ctx);
  assert.deepEqual(complete.calls.map(([name]) => name), ['admit', 'run', 'discard']);

  const cancelled = fixture({ inputs: [undefined] });
  await cancelled.reconcile();
  await cancelled.command.handler('run', cancelled.ctx);
  assert.deepEqual(cancelled.calls, []);
  assert.deepEqual(cancelled.notifications.at(-1), ['bounded run cancelled', 'warning']);
});

test('/bounded rollback aborts collection and late input cannot admit', async () => {
  const dialog = Promise.withResolvers();
  const opened = Promise.withResolvers();
  const f = fixture();
  await f.reconcile();
  let signal;
  f.ctx.ui.input = (_title, placeholder, options) => {
    assert.equal(placeholder, undefined);
    signal = options.signal;
    opened.resolve();
    return dialog.promise;
  };

  const command = f.command.handler('run', f.ctx);
  await opened.promise;
  await f.command.handler('rollback', f.ctx);
  assert.equal(signal.aborted, true);
  assert.deepEqual(f.calls.map(([name]) => name), ['rollback']);
  dialog.resolve('late outcome');
  await command;
  assert.deepEqual(f.calls.map(([name]) => name), ['rollback']);
});

test('/bounded rollback aborts confirmation and late approval cannot admit', async () => {
  const dialog = Promise.withResolvers();
  const opened = Promise.withResolvers();
  const f = fixture();
  await f.reconcile();
  let signal;
  f.ctx.ui.confirm = (_title, _message, options) => {
    signal = options.signal;
    opened.resolve();
    return dialog.promise;
  };

  const command = f.command.handler(COMPLETE_RUN, f.ctx);
  await opened.promise;
  await f.command.handler('rollback', f.ctx);
  assert.equal(signal.aborted, true);
  dialog.resolve(true);
  await command;
  assert.deepEqual(f.calls.map(([name]) => name), ['rollback']);
});

test('/bounded parses malformed or undefined arguments inside its error boundary', async () => {
  for (const args of [undefined, 'run --task "unterminated']) {
    const f = fixture();
    await f.reconcile();
    await f.command.handler(args, f.ctx);
    assert.equal(f.notifications.at(-1)[1], 'error');
    assert.deepEqual(f.calls, []);
  }
});

test('/bounded rejects host-owned flags but leaves path, budget, and gate policy to core admission', async () => {
  for (const flag of ['routing', 'provider', 'verifier', 'qualification', 'bounded-context']) {
    const f = fixture();
    await f.reconcile();
    await f.command.handler(`${COMPLETE_RUN} --${flag} attacker`, f.ctx);
    assert.deepEqual(f.calls, []);
  }

  for (const args of [
    COMPLETE_RUN.replace('--max-seconds 300', '--max-seconds 301'),
    COMPLETE_RUN.replace('approval-console/index.html,approval-console/test_index.py', '../outside'),
    COMPLETE_RUN.replace('all external effects', 'publish only'),
    COMPLETE_RUN.replace('human-approval', 'model-approval'),
  ]) {
    const f = fixture({ overrides: { admit: async () => { throw new Error('core policy rejected'); } } });
    await f.reconcile();
    await f.command.handler(args, f.ctx);
    assert.equal(f.calls[0][0], 'admit');
    assert.match(f.notifications.at(-1)[0], /core policy rejected/);
  }
});

test('/bounded rejects sensitive-looking literals without silently changing the preview', async () => {
  const rejected = fixture();
  await rejected.reconcile();
  await rejected.command.handler(COMPLETE_RUN.replace('tests pass', 'password=TEST_ONLY_VALUE'), rejected.ctx);
  assert.deepEqual(rejected.calls, []);
  assert.deepEqual(rejected.confirmations, []);
  assert.match(rejected.notifications.at(-1)[0], /secrets are not allowed/i);

  const generic = fixture();
  await generic.reconcile();
  await generic.command.handler(COMPLETE_RUN.replace('tests pass', 'document secret handling'), generic.ctx);
  assert.equal(JSON.parse(generic.confirmations[0][1]).acceptance, 'document secret handling');
});

test('/bounded run requires reconciled, idle, interactive state and immutable valid host defaults', async () => {
  const degraded = fixture();
  await degraded.command.handler(COMPLETE_RUN, degraded.ctx);
  assert.deepEqual(degraded.calls, []);

  const busy = fixture();
  await busy.reconcile();
  busy.ctx.isIdle = () => false;
  await busy.command.handler(COMPLETE_RUN, busy.ctx);
  assert.deepEqual(busy.calls, []);
  assert.match(busy.notifications.at(-1)[0], /idle/i);

  const headless = fixture();
  await headless.reconcile();
  headless.ctx.hasUI = false;
  await headless.command.handler(COMPLETE_RUN, headless.ctx);
  assert.deepEqual(headless.calls, []);

  for (const defaults of [
    { ...HOST_DEFAULTS, routing: null },
    { ...HOST_DEFAULTS, boundedContext: [] },
    { ...HOST_DEFAULTS, verifier: { ...HOST_DEFAULTS.verifier, resolve: () => 'secret' } },
  ]) assert.throws(() => fixture({ defaults }), /host admission defaults/i);
  const mutable = structuredClone(HOST_DEFAULTS);
  const cloned = fixture({ defaults: mutable });
  mutable.routing.reviewerFamily = 'attacker';
  await cloned.reconcile();
  await cloned.command.handler(COMPLETE_RUN, cloned.ctx);
  assert.equal(cloned.calls[0][1].routing.reviewerFamily, 'anthropic');
});

test('declining preview creates no admission or snapshots', async () => {
  const f = fixture({ confirmed: false });
  await f.reconcile();
  await f.command.handler(COMPLETE_RUN, f.ctx);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.notifications.at(-1), ['bounded run cancelled', 'warning']);
});

test('a post-confirmation contract mismatch is discarded before execution', async () => {
  const f = fixture({ overrides: {
    admit: async (request) => ({
      schema: 'omp-run-contract/v2', runId: 'run-1',
      task: { id: request.task.id, digest: sha256('different task') },
      acceptanceCheck: { id: request.acceptanceCheck.id, digest: sha256(request.acceptanceCheck.value) },
      writeScope: request.writeScope, budgets: request.budgets,
      requiredGates: [...request.requiredGates, 'external-effects-disabled'],
    }),
  } });
  await f.reconcile();
  await f.command.handler(COMPLETE_RUN, f.ctx);
  assert.deepEqual(f.calls.map(([name]) => name), ['admit', 'discard']);
  assert.equal(f.confirmations.length, 1);
  assert.match(f.notifications.at(-1)[0], /does not bind/);
});

test('/bounded status, rollback, and doctor call the matching core method', async () => {
  for (const action of ['status', 'rollback', 'doctor']) {
    const f = fixture();
    await f.command.handler(action, f.ctx);
    assert.deepEqual(f.calls.map(([name]) => name), [action]);
    assert.equal(f.notifications[0][1], 'info');
  }
});

test('/bounded doctor exposes blocked centralized guard health', async () => {
  const f = fixture({ overrides: {
    doctor: async () => ({ status: 'blocked', failures: ['guard reconciliation is stale'] }),
  } });
  await f.command.handler('doctor', f.ctx);
  assert.deepEqual(f.calls.map(([name]) => name), ['doctor']);
  assert.match(f.notifications[0][0], /guard reconciliation is stale/);
});

test('rollback failure latches every tool until verified recovery or a successful retry', async () => {
  const safeReason = 'Rollback failed; protected state is unverified. All OMP tools are blocked.';
  let rollbackAttempts = 0;
  let status = { level: 'L3-narrow-write', active: false, nextDeadline: null };
  const f = fixture({ overrides: {
    rollback: async (reason) => {
      rollbackAttempts += 1;
      if (rollbackAttempts === 1) throw new Error('guard state=unsafe failed');
      return { status: 'protected', reason };
    },
    status: async () => status,
  } });
  await f.reconcile();

  await f.command.handler('rollback', f.ctx);
  assert.deepEqual(await f.events.get('tool_call')({ toolName: 'write' }, {}), {
    block: true,
    reason: safeReason,
  });
  assert.doesNotMatch((await f.events.get('tool_call')({ toolName: 'read' }, {})).reason, /secret|unsafe/);
  await f.command.handler(COMPLETE_RUN, f.ctx);
  assert.equal(f.calls.filter(([name]) => name === 'admit').length, 0);
  assert.match(f.notifications.at(-1)[0], /protected state is unverified/);

  status = { level: 'L3-narrow-write', active: true, nextDeadline: '2026-08-11T00:01:00.000Z' };
  await f.events.get('session_switch')({}, f.ctx);
  assert.equal((await f.events.get('tool_call')({ toolName: 'write' }, {})).block, true);
  status = {};
  await f.events.get('session_branch')({}, f.ctx);
  assert.equal((await f.events.get('tool_call')({ toolName: 'write' }, {})).block, true);
  status = {
    level: 'L3-narrow-write', active: false,
    nextDeadline: '2026-08-11T00:01:00.000Z', drift: true,
  };
  await f.events.get('session_tree')({}, f.ctx);
  assert.equal((await f.events.get('tool_call')({ toolName: 'write' }, {})).block, true);
  status = { level: 'L3-narrow-write', active: false, nextDeadline: null };
  await f.events.get('session_start')({}, f.ctx);
  assert.equal((await f.events.get('tool_call')({ toolName: 'write' }, {})).block, true);
  await f.command.handler('status', f.ctx);
  assert.equal((await f.events.get('tool_call')({ toolName: 'write' }, {})).block, true);

  await f.command.handler('rollback', f.ctx);
  assert.equal(await f.events.get('tool_call')({ toolName: 'write' }, {}), undefined);
});

test('active bounded execution blocks every tool and rollback aborts it before core rollback', async () => {
  let release;
  const started = Promise.withResolvers();
  const rollbackStarted = Promise.withResolvers();
  const rollbackRelease = Promise.withResolvers();
  const f = fixture({ overrides: {
    run: async (_contract, { signal }) => new Promise((resolve, reject) => {
      release = resolve;
      started.resolve(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    rollback: async (reason) => {
      rollbackStarted.resolve();
      await rollbackRelease.promise;
      return { status: 'protected', reason };
    },
  } });
  await f.reconcile();
  const running = f.command.handler(COMPLETE_RUN, f.ctx);
  const signal = await started.promise;

  await f.command.handler(COMPLETE_RUN, f.ctx);
  assert.match(f.notifications.at(-1)[0], /another bounded command is active/);

  for (const toolName of ['read', 'write', 'custom_tool', 'mcp_server_tool', 'task']) {
    assert.deepEqual(await f.events.get('tool_call')({ toolName }, {}), {
      block: true,
      reason: 'Bounded run active; all other OMP tools are blocked.',
    });
  }
  const rollback = f.command.handler('rollback', f.ctx);
  await rollbackStarted.promise;
  assert.equal((await f.events.get('tool_call')({ toolName: 'read' }, {})).block, true);
  await f.command.handler(COMPLETE_RUN, f.ctx);
  assert.equal(f.notifications.some(([message]) => /another bounded command is active/.test(message)), true);
  rollbackRelease.resolve();
  await rollback;
  await running;
  release?.();

  assert.equal(signal.aborted, true);
  assert.deepEqual(f.calls.map(([name]) => name), ['admit', 'run', 'discard', 'rollback']);
  assert.equal(await f.events.get('tool_call')({ toolName: 'read' }, {}), undefined);
  assert.equal((await f.events.get('tool_call')({ toolName: 'task' }, {})).block, true);
});

test('scope widening guidance is limited to exact core execution failures', async () => {
  const exact = [
    'staged artifact escaped write scope',
    'staged artifacts violate write scope',
    'artifact quota or write scope violated',
  ];
  for (const message of exact) {
    const f = fixture({ overrides: { run: async () => { throw new Error(message); } } });
    await f.reconcile();
    await f.command.handler(COMPLETE_RUN, f.ctx);
    assert.match(f.notifications.at(-1)[0], /start a new \/bounded run contract/i);
  }
  const unrelated = fixture({ overrides: { run: async () => { throw new Error('scope negotiation failed'); } } });
  await unrelated.reconcile();
  await unrelated.command.handler(COMPLETE_RUN, unrelated.ctx);
  assert.match(unrelated.notifications.at(-1)[0], /scope negotiation failed/);
  assert.doesNotMatch(unrelated.notifications.at(-1)[0], /new \/bounded run contract/i);
});

test('command and tool rendering redact secrets and stay within ten KiB', async () => {
  const secret = 'TEST_ONLY_SECRET_MARKER';
  const nestedSecret = 'TEST_ONLY_PRIVATE_MARKER';
  const f = fixture({ overrides: { status: async () => ({
    apiKey: secret, nested: { clientSecret: nestedSecret }, output: 'x'.repeat(20 * 1024),
  }) } });
  await f.command.handler('status', f.ctx);
  assert.ok(Buffer.byteLength(f.notifications[0][0], 'utf8') <= 10 * 1024);
  assert.doesNotMatch(f.notifications[0][0], new RegExp(secret));
  assert.doesNotMatch(f.notifications[0][0], /private-value-/);

  const result = await f.events.get('tool_result')({
    toolName: 'custom', content: [{ type: 'text', text: `Authorization: Bearer ${secret}` }],
  }, {});
  assert.doesNotMatch(result.content[0].text, new RegExp(secret));

  const plaintext = await f.events.get('tool_result')({
    toolName: 'custom',
    content: [{
      type: 'text',
      text: 'password=TEST_ONLY_PASSWORD token: TEST_ONLY_TOKEN clientSecret=TEST_ONLY_CLIENT_SECRET {"refreshToken":"TEST_ONLY_REFRESH"} OPENAI_API_KEY=TEST_ONLY_OPENAI AWS_SECRET_ACCESS_KEY=TEST_ONLY_AWS GITHUB_TOKEN=TEST_ONLY_GITHUB {"token":"TEST_ONLY_TAIL"}',
    }],
  }, {});
  assert.doesNotMatch(plaintext.content[0].text, /TEST_ONLY_PASSWORD|TEST_ONLY_TOKEN|TEST_ONLY_CLIENT_SECRET|TEST_ONLY_REFRESH|TEST_ONLY_OPENAI|TEST_ONLY_AWS|TEST_ONLY_GITHUB|TEST_ONLY_TAIL/);
});
