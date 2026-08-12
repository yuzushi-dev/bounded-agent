import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256, stableSerialize, verifyReceipt } from '../../core/receipt.mjs';
import { createController } from '../../core/controller.mjs';
import { coreOptions, fixture, request } from './helpers.mjs';

test('receipt verification never throws for nullish input', () => {
  assert.equal(verifyReceipt(null, null).valid, false);
  assert.equal(verifyReceipt(undefined, undefined).valid, false);
});

test('receipt verification binds the contract and rejects altered evidence', async () => {
  const f = fixture();
  try {
    const controller = createController({
      ...coreOptions(f),
    });
    const contract = await controller.admit(request());
    const receipt = await controller.run(contract);

    assert.deepEqual(verifyReceipt(receipt, contract), { valid: true, findings: [] });
    assert.deepEqual(receipt.policy.externalEffects, { enabled: false, finalGate: 'human-approval' });
    const altered = structuredClone(receipt);
    altered.artifacts[0].bytes += 1;
    assert.equal(verifyReceipt(altered, contract).valid, false);
  } finally { f.cleanup(); }
});

test('receipt verification rejects self-consistent failed semantics', async () => {
  const f = fixture();
  try {
    const controller = createController({
      ...coreOptions(f),
    });
    const contract = await controller.admit(request());
    const receipt = await controller.run(contract);
    receipt.truncated = true;
    receipt.objectivesComplete = false;
    delete receipt.receiptDigest;
    receipt.receiptDigest = sha256(stableSerialize(receipt));

    assert.equal(verifyReceipt(receipt, contract).valid, false);
  } finally { f.cleanup(); }
});

test('receipt verification rejects self-consistent invalid activation timing', async () => {
  const f = fixture();
  try {
    const controller = createController(coreOptions(f));
    const contract = await controller.admit(request());
    const receipt = await controller.run(contract);
    receipt.activatedAt = new Date(Date.parse(receipt.admittedAt) - 1).toISOString();
    receipt.expiresAt = new Date(Date.parse(receipt.activatedAt) + 300_001).toISOString();
    delete receipt.receiptDigest;
    receipt.receiptDigest = sha256(stableSerialize(receipt));

    assert.equal(verifyReceipt(receipt, contract).valid, false);
  } finally { f.cleanup(); }
});

test('receipt verification binds activation freshness and exact admitted duration', async () => {
  const f = fixture();
  try {
    const controller = createController(coreOptions(f));
    const contract = await controller.admit(request());
    const receipt = await controller.run(contract);
    const duration = Date.parse(contract.expiresAt) - Date.parse(contract.createdAt);
    receipt.activatedAt = new Date(Date.parse(receipt.admittedAt) + 5_001).toISOString();
    receipt.completedAt = new Date(Date.parse(receipt.activatedAt) + 1).toISOString();
    receipt.expiresAt = new Date(Date.parse(receipt.activatedAt) + duration).toISOString();
    delete receipt.receiptDigest;
    receipt.receiptDigest = sha256(stableSerialize(receipt));
    assert.equal(verifyReceipt(receipt, contract).valid, false);

    receipt.activatedAt = receipt.admittedAt;
    receipt.completedAt = new Date(Date.parse(receipt.activatedAt) + 1).toISOString();
    receipt.expiresAt = new Date(Date.parse(receipt.activatedAt) + duration - 1).toISOString();
    delete receipt.receiptDigest;
    receipt.receiptDigest = sha256(stableSerialize(receipt));
    assert.equal(verifyReceipt(receipt, contract).valid, false);
  } finally { f.cleanup(); }
});

test('receipt verification rejects recomputed usage above contract budgets', async () => {
  const f = fixture();
  try {
    const controller = createController(coreOptions(f));
    const contract = await controller.admit(request());
    const receipt = await controller.run(contract);
    receipt.budgetUsage.artifactBytes = contract.budgets.maxArtifactBytes + 1;
    delete receipt.receiptDigest;
    receipt.receiptDigest = sha256(stableSerialize(receipt));

    assert.equal(verifyReceipt(receipt, contract).valid, false);
  } finally { f.cleanup(); }
});

test('receipt verification rejects arbitrary top-level and budget fields', async () => {
  const f = fixture();
  try {
    const controller = createController(coreOptions(f));
    const contract = await controller.admit(request());
    const receipt = await controller.run(contract);
    receipt.secret = 'must-not-leak';
    receipt.budgetUsage.unmeasured = 1;
    delete receipt.receiptDigest;
    receipt.receiptDigest = sha256(stableSerialize(receipt));

    assert.equal(verifyReceipt(receipt, contract).valid, false);
  } finally { f.cleanup(); }
});
