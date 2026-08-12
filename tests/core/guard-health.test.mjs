import assert from 'node:assert/strict';
import test from 'node:test';

import { guardHealthDiagnostics, guardHealthFailures } from '../../core/guard-health.mjs';

const healthy = () => ({
  timerActive: true,
  timerEnabled: 'enabled',
  serviceResult: 'success',
  execMainStatus: 0,
  lastReconciled: 100_000_000,
  monotonicNow: 100_000_001,
});

test('runtime-only enablement is not reboot-safe', () => {
  assert.deepEqual(guardHealthFailures({ ...healthy(), timerEnabled: 'enabled-runtime' }), [
    'guard timer is disabled',
  ]);
});

test('guard health requires enabled active timer and fresh successful reconciliation', () => {
  assert.deepEqual(guardHealthFailures(healthy()), []);
  for (const [field, value] of [
    ['timerActive', false], ['timerEnabled', false], ['serviceResult', 'failed'], ['execMainStatus', 1],
    ['lastReconciled', null], ['monotonicNow', 220_000_002],
  ]) {
    const report = healthy();
    report[field] = value;
    assert.equal(guardHealthFailures(report).length > 0, true, field);
  }
  assert.equal(guardHealthFailures({ ...healthy(), lastReconciled: true }).length > 0, true);
});

test('guard health rejects a mismatched monotonic timestamp epoch as stale', () => {
  assert.deepEqual(guardHealthFailures({
    ...healthy(), lastReconciled: 9_000_000_000, monotonicNow: 1_000_000_000,
  }), ['guard reconciliation is stale']);
});

test('guard health diagnostics are numeric and secret-free', () => {
  assert.deepEqual(guardHealthDiagnostics({ lastReconciled: 100, monotonicNow: 145 }), {
    lastReconciledUs: 100, monotonicNowUs: 145, reconciliationAgeUs: 45, maxAgeUs: 120_000_000,
  });
  assert.deepEqual(guardHealthDiagnostics({ lastReconciled: null, monotonicNow: 145 }), {
    lastReconciledUs: null, monotonicNowUs: 145, reconciliationAgeUs: null, maxAgeUs: 120_000_000,
  });
});
