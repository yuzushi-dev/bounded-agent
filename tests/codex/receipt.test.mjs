import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createContract, stableSerialize } from '../../plugins/bounded/src/contract.mjs';
import { createReceipt, verifyReceipt } from '../../plugins/bounded/src/receipt.mjs';

const NOW = '2026-08-11T12:00:00.000Z';
const DONE = '2026-08-11T12:00:01.000Z';
const KEY = Buffer.from('bounded-test-receipt-key');

function fixture() {
  const contract = createContract({
    cwd: '/tmp/bounded-receipt-project',
    task: 'update one file',
    acceptanceCheck: 'external check',
    scope: ['src/index.mjs'],
    maxSeconds: 30,
    maxReadBytes: 4096,
    maxArtifactBytes: 4096,
    maxOutputBytes: 4096,
    maxRequests: 4,
    prohibitedEffects: 'all external effects',
    finalGate: 'human-approval',
  }, { now: NOW });
  const state = {
    runId: 'b'.repeat(64),
    sessionId: 'thr_receipt_test',
    startedAt: NOW,
    requestCount: 1,
    readBytes: 12,
    artifactBytes: 8,
    outputBytes: 4,
  };
  return { contract, state };
}

test('verifies receipt semantics against the expected contract and run', () => {
  const { contract, state } = fixture();
  const receipt = createReceipt({
    contract,
    state,
    result: 'accepted',
    now: DONE,
    acceptanceRef: 'human confirmed',
    receiptKey: KEY,
  });
  assert.equal(verifyReceipt(receipt, { contract, runId: state.runId, receiptKey: KEY }).valid, true);
  assert.equal(verifyReceipt(receipt, { contract: { ...contract, task: 'drifted' }, runId: state.runId, receiptKey: KEY }).valid, false);
  assert.equal(verifyReceipt(receipt, { contract, runId: 'c'.repeat(64), receiptKey: KEY }).valid, false);
  assert.equal(verifyReceipt(receipt, { contract, runId: state.runId }).valid, false);
});

test('rejects semantically invalid receipts even when re-signed', () => {
  const { contract, state } = fixture();
  const receipt = createReceipt({ contract, state, result: 'accepted', now: DONE, acceptanceRef: 'human confirmed', receiptKey: KEY });
  const invalidUnsigned = { ...receipt, counters: { ...receipt.counters, readBytes: -1 } };
  delete invalidUnsigned.digest;
  const invalid = {
    ...invalidUnsigned,
    digest: `hmac-sha256:${crypto.createHmac('sha256', KEY).update(stableSerialize(invalidUnsigned)).digest('hex')}`,
  };
  assert.equal(verifyReceipt(invalid, { contract, runId: state.runId, receiptKey: KEY }).valid, false);
});
