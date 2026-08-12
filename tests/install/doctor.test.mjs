import assert from 'node:assert/strict';
import test from 'node:test';

import { deadline, doctor, reconcile } from '../../scripts/doctor.mjs';

test('deadline delegates exact run handling to the production guard entrypoint', async () => {
  const calls = [];
  const runId = `run_${'a'.repeat(24)}`;
  const load = () => ({ guard: { deadline: async (value) => { calls.push(value); return { status: 'protected' }; } } });
  assert.deepEqual(await deadline({ manifestPath: '/tmp/manifest.json', runId, load }), { status: 'protected' });
  assert.deepEqual(calls, [runId]);
});

test('deadline rejects malformed run ids before loading the installation', async () => {
  let loaded = false;
  await assert.rejects(deadline({ manifestPath: '/tmp/manifest.json', runId: 'wrong', load: () => { loaded = true; } }), /run.?id/i);
  assert.equal(loaded, false);
});

test('doctor reports controller and guard failures without hiding either', async () => {
  const load = () => ({
    controller: { doctor: async () => ({ status: 'blocked', failures: ['qualification expired'] }) },
    guard: { status: async () => ({
      timerActive: false, timerEnabled: false, drift: true,
      serviceResult: 'failed', execMainStatus: 1, lastReconciled: null, monotonicNow: 1,
    }) },
  });
  assert.deepEqual(await doctor({ manifestPath: '/tmp/manifest.json', load }), {
    status: 'blocked',
    failures: [
      'qualification expired', 'guard timer is inactive', 'guard timer is disabled', 'guard reconciliation has not succeeded',
      'guard reconciliation exited unsuccessfully', 'guard reconciliation is stale', 'guard drift detected',
    ],
    diagnostics: { lastReconciledUs: null, monotonicNowUs: 1, reconciliationAgeUs: null, maxAgeUs: 120_000_000 },
  });
});

test('reconcile invokes the installation guard directly for boot and expiry recovery', async () => {
  const calls = [];
  const load = () => ({ guard: { reconcile: async () => { calls.push('reconcile'); return { status: 'protected' }; } } });
  assert.deepEqual(await reconcile({ manifestPath: '/tmp/manifest.json', load }), { status: 'protected' });
  assert.deepEqual(calls, ['reconcile']);
});

test('doctor does not report ready for an active timer whose oneshot never reconciled successfully', async () => {
  const load = () => ({
    controller: { doctor: async () => ({ status: 'ready', failures: [] }) },
    guard: { status: async () => ({
      timerActive: true, timerEnabled: 'enabled', drift: false,
      serviceResult: 'success', execMainStatus: 0, lastReconciled: null, monotonicNow: 1,
    }) },
  });
  assert.deepEqual(await doctor({ manifestPath: '/tmp/manifest.json', load }), {
    status: 'blocked', failures: ['guard reconciliation is stale'],
    diagnostics: { lastReconciledUs: null, monotonicNowUs: 1, reconciliationAgeUs: null, maxAgeUs: 120_000_000 },
  });
});

test('doctor blocks a currently active timer that is disabled for the next login or reboot', async () => {
  const load = () => ({
    controller: { doctor: async () => ({ status: 'ready', failures: [] }) },
    guard: { status: async () => ({
      timerActive: true, timerEnabled: false, drift: false,
      serviceResult: 'success', execMainStatus: 0, lastReconciled: 1, monotonicNow: 1,
    }) },
  });
  assert.deepEqual(await doctor({ manifestPath: '/tmp/manifest.json', load }), {
    status: 'blocked', failures: ['guard timer is disabled'],
    diagnostics: { lastReconciledUs: 1, monotonicNowUs: 1, reconciliationAgeUs: 0, maxAgeUs: 120_000_000 },
  });
});

test('reconcile hands delivery recovery to the controller before reporting protected', async () => {
  const calls = [];
  const load = () => ({
    guard: { reconcile: async () => { calls.push('guard'); return { status: 'controller-required', reason: 'delivery' }; } },
    controller: { status: async () => { calls.push('controller'); return { active: false }; } },
  });
  assert.deepEqual(await reconcile({ manifestPath: '/tmp/manifest.json', load }), {
    status: 'protected', reason: 'delivery',
  });
  assert.deepEqual(calls, ['guard', 'controller']);
});
