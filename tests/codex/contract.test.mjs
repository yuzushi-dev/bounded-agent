import test from 'node:test';
import assert from 'node:assert/strict';

import { createContract, validateContract } from '../../plugins/bounded/src/contract.mjs';

const NOW = '2026-08-11T12:00:00.000Z';

function request(overrides = {}) {
  return {
    cwd: '/tmp/bounded-project',
    task: 'Update src/index.mjs',
    acceptanceCheck: 'node --test test/index.test.mjs',
    scope: ['src/index.mjs', 'test/index.test.mjs'],
    maxSeconds: 30,
    maxReadBytes: 4096,
    maxArtifactBytes: 4096,
    maxOutputBytes: 4096,
    maxRequests: 2,
    prohibitedEffects: 'all external effects',
    finalGate: 'human-approval',
    ...overrides,
  };
}

test('creates and validates a digest-bound bounded contract', () => {
  const contract = createContract(request(), { now: NOW });

  assert.equal(contract.schema, 'bounded-run-contract/v1');
  assert.match(contract.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(contract.cwd, '/tmp/bounded-project');
  assert.deepEqual(contract.scope.paths, ['src/index.mjs', 'test/index.test.mjs']);
  assert.equal(validateContract(contract, { now: NOW }), true);
});

test('rejects unsafe scope, budgets, effects, and credential-looking input', () => {
  assert.throws(() => createContract(request({ scope: ['../outside'] }), { now: NOW }), /scope/i);
  assert.throws(() => createContract(request({ maxSeconds: 301 }), { now: NOW }), /seconds/i);
  assert.throws(() => createContract(request({ maxRequests: 1 }), { now: NOW }), /requests/i);
  assert.throws(() => createContract(request({ externalEffects: { enabled: true } }), { now: NOW }), /external effects/i);
  assert.throws(() => createContract(request({ task: 'rotate api_key=secret' }), { now: NOW }), /credential|secret/i);
});

test('rejects expired and digest-drifted contracts', () => {
  const contract = createContract(request({ maxSeconds: 1 }), { now: NOW });
  const expiredAt = new Date(Date.parse(NOW) + 1001).toISOString();
  assert.throws(() => validateContract(contract, { now: expiredAt }), /expired|stale/i);

  const drifted = { ...contract, task: 'different task' };
  assert.throws(() => validateContract(drifted, { now: NOW }), /digest|contract/i);
});
