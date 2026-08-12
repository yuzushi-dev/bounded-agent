import crypto from 'node:crypto';

import { containsCredentialMaterial, sha256, stableSerialize, validateContract } from './contract.mjs';

const RECEIPT_KEYS = [
  'acceptanceRef', 'completedAt', 'contractDigest', 'counters', 'cwd', 'digest', 'result', 'runId', 'schema',
  'sessionId', 'startedAt',
];
const COUNTER_KEYS = ['artifactBytes', 'outputBytes', 'readBytes', 'requestCount'];
const RESULTS = new Set(['accepted', 'rejected', 'rolled-back', 'expired', 'budget-exceeded']);

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function canonicalIso(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function validKey(value) {
  return typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function signingKey(value) {
  if (!validKey(value)) throw new Error('receipt key is required');
  const key = Buffer.from(value);
  if (key.length < 16) throw new Error('receipt key is too short');
  return key;
}

function unsigned(receipt) {
  const { digest: _digest, ...value } = receipt;
  return value;
}

function sign(receipt, key) {
  return `hmac-sha256:${crypto.createHmac('sha256', signingKey(key)).update(stableSerialize(receipt)).digest('hex')}`;
}

function validRunId(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function semanticShape(receipt, { contract, runId } = {}) {
  if (!exactKeys(receipt, RECEIPT_KEYS)
    || receipt.schema !== 'bounded-receipt/v1'
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.contractDigest)
    || !/^hmac-sha256:[a-f0-9]{64}$/.test(receipt.digest)
    || !validRunId(receipt.runId)
    || typeof receipt.sessionId !== 'string' || !receipt.sessionId.trim() || receipt.sessionId.length > 256
    || typeof receipt.cwd !== 'string' || !receipt.cwd.trim()
    || !RESULTS.has(receipt.result)
    || typeof receipt.acceptanceRef !== 'string' || receipt.acceptanceRef.length > 8192
    || !exactKeys(receipt.counters, COUNTER_KEYS)
    || !Object.values(receipt.counters).every(validCounter)
    || containsCredentialMaterial(receipt)) {
    return { valid: false, reason: 'receipt shape is invalid' };
  }
  try {
    const startedAt = canonicalIso(receipt.startedAt, 'receipt startedAt');
    const completedAt = canonicalIso(receipt.completedAt, 'receipt completedAt');
    if (Date.parse(completedAt) < Date.parse(startedAt)) return { valid: false, reason: 'receipt timestamps are invalid' };
    if (['accepted', 'rejected', 'rolled-back'].includes(receipt.result) && !receipt.acceptanceRef.trim()) {
      return { valid: false, reason: 'receipt reference is required' };
    }
    if (contract) {
      validateContract(contract);
      if (receipt.contractDigest !== contract.digest || receipt.cwd !== contract.cwd
        || receipt.counters.requestCount > contract.budgets.maxRequests
        || receipt.counters.readBytes > contract.budgets.maxReadBytes
        || receipt.counters.artifactBytes > contract.budgets.maxArtifactBytes
        || receipt.counters.outputBytes > contract.budgets.maxOutputBytes) {
        return { valid: false, reason: 'receipt does not match the contract' };
      }
    }
    if (runId !== undefined && receipt.runId !== runId) return { valid: false, reason: 'receipt run is unexpected' };
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'receipt is invalid' };
  }
}

export function createReceipt({ contract, state, result, now, acceptanceRef = '', receiptKey }) {
  validateContract(contract);
  if (!RESULTS.has(result)) throw new Error('receipt result is invalid');
  if (typeof acceptanceRef !== 'string' || acceptanceRef.length > 8192 || containsCredentialMaterial(acceptanceRef)) {
    throw new Error('receipt reference is invalid');
  }
  if (!validRunId(state?.runId) || typeof state.sessionId !== 'string' || !state.sessionId.trim()) {
    throw new Error('receipt run identity is invalid');
  }
  const startedAt = canonicalIso(state.startedAt, 'receipt startedAt');
  const completedAt = canonicalIso(now, 'receipt completedAt');
  const counters = {
    requestCount: state.requestCount,
    readBytes: state.readBytes,
    artifactBytes: state.artifactBytes,
    outputBytes: state.outputBytes,
  };
  if (!Object.values(counters).every(validCounter)) throw new Error('receipt counters are invalid');
  const receipt = {
    schema: 'bounded-receipt/v1',
    cwd: contract.cwd,
    contractDigest: contract.digest,
    runId: state.runId,
    sessionId: state.sessionId,
    startedAt,
    completedAt,
    result,
    counters,
    acceptanceRef,
  };
  const shape = semanticShape({ ...receipt, digest: 'hmac-sha256:' + '0'.repeat(64) }, { contract, runId: state.runId });
  if (!shape.valid) throw new Error(shape.reason);
  const signed = { ...receipt, digest: sign(receipt, receiptKey) };
  if (containsCredentialMaterial(signed)) throw new Error('receipt contains credential material');
  return signed;
}

export function verifyReceipt(receipt, { contract, runId, receiptKey } = {}) {
  const shape = semanticShape(receipt, { contract, runId });
  if (!shape.valid) return shape;
  try {
    const expected = sign(unsigned(receipt), receiptKey);
    const actual = Buffer.from(receipt.digest);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted)
      ? { valid: true, receipt: structuredClone(receipt) }
      : { valid: false, reason: 'receipt signature does not match its contents' };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'receipt signature is invalid' };
  }
}

export function receiptDigest(receipt) {
  return sha256(stableSerialize(receipt));
}
