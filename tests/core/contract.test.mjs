import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createController } from '../../core/controller.mjs';
import { validateContract } from '../../core/contract.mjs';
import { commandDigest, coreOptions, fixture, NOW, request } from './helpers.mjs';

test('constructor rejects relative, aliased, and writable state paths', async () => {
  const f = fixture();
  try {
    assert.throws(() => createController({
      ...coreOptions(f), statePath: 'state.json',
    }), /statePath.*absolute/i);
    (await import('node:fs')).chmodSync(f.statePath, 0o666);
    assert.throws(() => createController({
      ...coreOptions(f),
    }), /host-owned|permissions/i);
  } finally { f.cleanup(); }
});

test('constructor rejects ambient executor functions instead of trusting sandbox claims', () => {
  const f = fixture();
  try {
    assert.throws(() => createController({
      statePath: f.statePath,
      receiptRoot: f.receiptRoot,
      deliveryRoot: f.root,
      clock: f.clock,
      executor: f.executor,
      verifier: f.verifier,
      worker: f.worker,
      verifierCommand: f.verifierCommand,
      guard: f.guard,
      bwrapPath: '/usr/bin/bwrap',
      prlimitPath: '/usr/bin/prlimit',
      flockPath: '/usr/bin/flock',
    }), /ambient executor|command spec/i);
  } finally { f.cleanup(); }
});

test('constructor requires a validated nodePath instead of ambient process.execPath', () => {
  const f = fixture();
  try {
    const options = coreOptions(f);
    delete options.nodePath;
    assert.throws(() => createController(options), /nodePath/i);
    assert.throws(() => createController({ ...coreOptions(f), nodePath: '/usr/bin/true' }), /nodePath|qualification|runtime mounts/i);
  } finally { f.cleanup(); }
});

test('constructor rejects an input root identical to the delivery root', () => {
  const f = fixture();
  try {
    assert.throws(() => createController({ ...coreOptions(f), inputRoot: f.deliveryRoot }), /separate.*boundar/i);
  } finally { f.cleanup(); }
});

test('constructor keeps qualification evidence outside mounted input roots', () => {
  const f = fixture();
  try {
    const exposed = `${f.inputRoot}/input/qualification.mjs`;
    fs.writeFileSync(exposed, 'evidence', { mode: 0o600 });
    assert.throws(() => createController({
      ...coreOptions(f),
      qualificationPaths: { ...f.qualificationPaths, sources: { controller: exposed } },
    }), /qualification.*outside|untrusted root/i);
  } finally { f.cleanup(); }
});

test('constructor requires exact qualified runtime mounts', async () => {
  const f = fixture();
  try {
    assert.throws(() => createController({ ...coreOptions(f), runtimeMounts: [] }), /runtimeMounts/i);
    assert.throws(() => createController({
      ...coreOptions(f), runtimeMounts: [...f.runtimeMounts, { source: '/', target: '/host' }],
    }), /runtimeMounts|supported FHS/i);
    const altered = f.runtimeMounts.slice(0, -1);
    assert.throws(() => createController({ ...coreOptions(f), runtimeMounts: altered }), /capability|qualification|mount/i);
  } finally { f.cleanup(); }
});

test('constructor accepts overflow uid only for exact supported FHS mounts and host tools', (t) => {
  const f = fixture();
  const originalLstat = fs.lstatSync;
  const supportedSources = new Set([
    ...f.runtimeMounts.map(({ source }) => source), f.bwrapPath, f.prlimitPath, f.flockPath,
  ]);
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    const stat = originalLstat(target, ...args);
    if (!supportedSources.has(target)) return stat;
    return new Proxy(stat, {
      get(value, property) {
        if (property === 'uid') return 65534;
        const result = Reflect.get(value, property, value);
        return typeof result === 'function' ? result.bind(value) : result;
      },
    });
  });
  try {
    assert.doesNotThrow(() => createController(coreOptions(f)));
    const arbitraryTool = `${f.root}/arbitrary-tool`;
    fs.writeFileSync(arbitraryTool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.throws(() => createController({
      ...coreOptions(f), bwrapPath: arbitraryTool,
    }), /host-owned runtime executable/i);
    assert.throws(() => createController({
      ...coreOptions(f), runtimeMounts: [...f.runtimeMounts, { source: f.inputRoot, target: '/host' }],
    }), /runtimeMounts|supported FHS/i);
  } finally { f.cleanup(); }
});

test('controller accepts the existing host-owned state schema without volatile recovery fields', async () => {
  const f = fixture();
  try {
    const fs = await import('node:fs');
    const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    state.schema = 'omp-host-trusted-state/v1';
    delete state.pending;
    delete state.active;
    fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`);
    const controller = createController({
      ...coreOptions(f),
    });

    const contract = await controller.admit(request());

    assert.equal(contract.schema, 'omp-run-contract/v2');
  } finally { f.cleanup(); }
});

test('contract validation is closed and rejects unsafe routing, retry, and phase fields', async () => {
  const f = fixture();
  try {
    const controller = createController({
      ...coreOptions(f),
    });
    await assert.rejects(controller.admit(request({ retries: {} })), /retry/i);
    await assert.rejects(controller.admit(request({ phase: 'publish' })), /phase/i);
    const unsafe = request();
    unsafe.routing.chains[0].selectors = ['anthropic/claude-opus-5:high'];
    await assert.rejects(controller.admit(unsafe), /routing/i);

    const contract = await controller.admit(request({ toolCallId: 'valid-contract' }));
    assert.deepEqual(validateContract(contract, { now: contract.createdAt }), { valid: true, findings: [] });
    const altered = structuredClone(contract);
    altered.unknown = true;
    assert.equal(validateContract(altered).valid, false);
  } finally { f.cleanup(); }
});

test('admit rejects executor and reviewer aliases from the same provider family', async () => {
  const f = fixture();
  try {
    const aliasRouting = {
      reviewerFamily: 'openai',
      chains: [
        { role: 'task', family: 'openai-codex', selectors: ['openai-codex/gpt-5.6-sol:high'] },
        { role: 'reviewer', family: 'openai', selectors: ['openai/gpt-5.6-sol:high'] },
      ],
    };
    const state = JSON.parse((await import('node:fs')).readFileSync(f.statePath, 'utf8'));
    state.routing = aliasRouting;
    (await import('node:fs')).writeFileSync(f.statePath, `${JSON.stringify(state)}\n`);
    const controller = createController({
      ...coreOptions(f),
    });
    await assert.rejects(controller.admit(request({ routing: aliasRouting })), /independence/i);
  } finally { f.cleanup(); }
});

test('qualification is recomputed from constructor-owned files, fresh, and task-bound', async () => {
  const f = fixture();
  try {
    const fs = await import('node:fs');
    const source = f.qualificationPaths.sources.controller;
    fs.writeFileSync(source, 'drifted controller\n', { mode: 0o600 });
    await assert.rejects(createController(coreOptions(f)).admit(request()), /qualification|drift/i);

    fs.writeFileSync(source, 'qualified controller\n', { mode: 0o600 });
    const expired = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    expired.qualification.expiresAt = NOW;
    fs.writeFileSync(f.statePath, `${JSON.stringify(expired)}\n`, { mode: 0o600 });
    await assert.rejects(createController(coreOptions(f)).admit(request()), /qualification|expired|fresh/i);

    expired.qualification.expiresAt = '2026-08-11T00:10:00.000Z';
    fs.writeFileSync(f.statePath, `${JSON.stringify(expired)}\n`, { mode: 0o600 });
    await assert.rejects(createController(coreOptions(f)).admit(request({
      task: { id: 'task-2', value: 'different task' },
    })), /qualification|task/i);
  } finally { f.cleanup(); }
});

test('qualification binds exact scope and parsed suite/review evidence', async () => {
  const f = fixture();
  try {
    const fs = await import('node:fs');
    const core = createController(coreOptions(f));
    await assert.rejects(core.admit(request({
      writeScope: { paths: ['artifacts/other.txt'], patchPaths: [], maxFiles: 1 },
      delivery: { mode: 'local', outputPaths: ['artifacts/other.txt'] },
    })), /qualification|scope/i);
    fs.writeFileSync(`${f.inputRoot}/input/other.md`, 'other', { mode: 0o600 });
    await assert.rejects(core.admit(request({
      boundedContext: { sessionPath: 'sessions/run.jsonl', readPaths: ['input/other.md'], maxBytes: 1024 },
    })), /qualification|scope/i);

    const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    const suite = JSON.parse(fs.readFileSync(f.qualificationPaths.suite, 'utf8'));
    suite.passed = false;
    fs.writeFileSync(f.qualificationPaths.suite, `${JSON.stringify(suite)}\n`, { mode: 0o600 });
    state.qualification.suiteDigest = (await import('./helpers.mjs')).digest(fs.readFileSync(f.qualificationPaths.suite));
    fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await assert.rejects(createController(coreOptions(f)).admit(request()), /suite|qualification/i);
  } finally { f.cleanup(); }
});

test('capability families are host-bound to qualified routing', async () => {
  const f = fixture();
  try {
    const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    state.qualification.verifierCapability.family = state.routing.chains.find(({ role }) => role === 'task').family;
    fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await assert.rejects(createController(coreOptions(f)).admit(request()), /qualification|capability/i);
  } finally { f.cleanup(); }
});

test('admit rejects capability substitution without a bound sandbox probe', async () => {
  const f = fixture();
  try {
    const substitutedWorker = { command: '/usr/bin/true', args: [] };
    const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    const capabilities = JSON.parse(fs.readFileSync(f.qualificationPaths.capabilities, 'utf8'));
    state.qualification.workerCapability.digest = commandDigest(substitutedWorker);
    capabilities.worker.digest = commandDigest(substitutedWorker);
    fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.writeFileSync(f.qualificationPaths.capabilities, `${JSON.stringify(capabilities)}\n`, { mode: 0o600 });
    await assert.rejects(createController({ ...coreOptions(f), worker: substitutedWorker }).admit(request()), /probe|qualification|suite/i);

    const missingShebang = `${f.root}/missing-shebang`;
    fs.writeFileSync(missingShebang, 'not an executable format\n', { mode: 0o700 });
    assert.throws(() => createController({
      ...coreOptions(f), worker: { command: missingShebang, args: [] },
    }), /outside qualified runtime mounts/i);
  } finally { f.cleanup(); }
});

test('constructor rejects a supported-path script with an unavailable shebang interpreter', () => {
  const f = fixture();
  try {
    assert.throws(() => createController({
      ...coreOptions(f), worker: { command: '/usr/bin/loweb', args: [] },
    }), /shebang interpreter.*outside qualified runtime mounts/i);
  } finally { f.cleanup(); }
});

test('admit never returns a contract rejected by the public validator', async () => {
  const f = fixture();
  try {
    const controller = createController({
      ...coreOptions(f),
    });
    await assert.rejects(controller.admit(request({ toolCallId: 'has space' })), /contract|tool-call/i);
    await assert.rejects(controller.admit(request({ acceptanceCheck: null })), /acceptance/i);
    await assert.rejects(controller.admit(request({
      budgets: { ...request().budgets, surprise: 1 },
    })), /contract|budget/i);

    const contract = await controller.admit(request({ toolCallId: 'nested-closure' }));
    const altered = structuredClone(contract);
    altered.stopPolicy.surprise = true;
    assert.equal(validateContract(altered).valid, false);
  } finally { f.cleanup(); }
});

test('admit assigns identity and a host-bounded immutable 300-second contract', async () => {
  const f = fixture();
  try {
    const controller = createController({
      ...coreOptions(f),
    });
    const contract = await controller.admit(request());

    assert.equal(contract.schema, 'omp-run-contract/v2');
    assert.match(contract.runId, /^run_[a-f0-9]{24}$/);
    assert.equal(contract.createdAt, f.clock());
    assert.equal(Date.parse(contract.expiresAt) - Date.parse(contract.createdAt), 300_000);
    assert.equal(contract.deadline, contract.expiresAt);
    assert.equal(contract.trigger.value, undefined);
    assert.equal(contract.task.value, undefined);
    assert.equal(contract.allowFallback, false);
    assert.equal(contract.externalEffects, undefined);
    assert.ok(contract.requiredGates.includes('external-effects-disabled'));
    assert.equal(contract.delivery.receiptPath, `receipts/${contract.runId}.json`);
    assert.ok(Object.isFrozen(contract));
    assert.ok(Object.isFrozen(contract.writeScope));
  } finally { f.cleanup(); }
});

test('maxWorkers denotes the single sandbox worker invocation', async () => {
  const f = fixture();
  try {
    await assert.rejects(createController(coreOptions(f)).admit(request({
      budgets: { ...request().budgets, maxWorkers: 2 },
    })), /budget/i);
  } finally { f.cleanup(); }
});

test('delivery paths exactly equal the unique write scope', async () => {
  const f = fixture();
  try {
    await assert.rejects(createController(coreOptions(f)).admit(request({
      writeScope: { paths: ['artifacts/result.txt'], patchPaths: ['artifacts/change.patch'], maxFiles: 2 },
      delivery: { mode: 'local', outputPaths: ['artifacts/result.txt', 'artifacts/result.txt'] },
    })), /delivery/i);
  } finally { f.cleanup(); }
});

test('admit rejects unsafe scope, oversized windows, external effects, and qualification drift', async () => {
  const f = fixture();
  try {
    const controller = createController({
      ...coreOptions(f),
    });
    await assert.rejects(controller.admit(request({ writeScope: { paths: ['../escape'], patchPaths: [] } })), /write-scope/i);
    await assert.rejects(controller.admit(request({ maxSeconds: 301 })), /300 seconds/i);
    await assert.rejects(controller.admit(request({ externalEffects: { enabled: true, finalGate: 'human-approval' } })), /external effects/i);
    await assert.rejects(controller.admit(request({ prohibitedEffects: 'publish only' })), /external effects/i);

    const state = JSON.parse(await (await import('node:fs/promises')).readFile(f.statePath, 'utf8'));
    state.qualification.status = 'stale';
    await (await import('node:fs/promises')).writeFile(f.statePath, `${JSON.stringify(state)}\n`);
    await assert.rejects(controller.admit(request()), /qualification/i);
  } finally { f.cleanup(); }
});
