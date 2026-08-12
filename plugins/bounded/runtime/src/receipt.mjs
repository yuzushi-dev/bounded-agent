import { createHash } from 'node:crypto';

import { sha256, stableSerialize, validateContract } from './contract.mjs';

const RESULTS = new Set(['completed', 'rolled-back', 'failed', 'expired', 'preserved']);
const COUNTERS = ['artifactBytes', 'outputBytes', 'readBytes', 'requests', 'workers'];

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function sign(value, key) {
  return `hmac-sha256:${createHash('sha256').update(`${key}\0${stableSerialize(value)}`).digest('hex')}`;
}

function unsigned(receipt) {
  const { digest: _digest, ...value } = receipt;
  return value;
}

function validCounters(value, contract) {
  return exact(value, COUNTERS) && COUNTERS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && value.requests <= contract.budgets.maxRequests && value.workers <= contract.budgets.maxWorkers
    && value.readBytes <= contract.budgets.maxReadBytes && value.artifactBytes <= contract.budgets.maxArtifactBytes
    && value.outputBytes <= contract.budgets.maxOutputBytes;
}

function keyFor(contract) { return sha256(`${contract.digest}\0${contract.runId}`); }

export function createReceipt({ contract, state, leaseId, result, counters, artifacts, acceptance = null, reason = '', completedAt }) {
  if (!validateContract(contract).valid || state?.runId !== contract.runId || state?.clientId !== contract.clientId
    || !['running', 'completed', 'failed', 'rolled-back', 'expired', 'preserved'].includes(state?.status)) throw new Error('receipt state is invalid');
  if (!RESULTS.has(result) || typeof leaseId !== 'string' || leaseId !== state.leaseId || !validCounters(counters, contract)) {
    throw new Error('receipt result, lease, or counters are invalid');
  }
  if (!Array.isArray(artifacts) || artifacts.some((artifact) => !exact(artifact, ['bytes', 'digest', 'path'])
    || !contract.delivery.outputPaths.includes(artifact.path) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || ''))) throw new Error('receipt artifact is invalid');
  if (result === 'completed' && (!acceptance?.passed || acceptance.digest !== contract.acceptanceCheck.digest)) {
    throw new Error('receipt acceptance is not passed');
  }
  const value = {
    schema: 'bounded-runtime-receipt/v1', runId: contract.runId, clientId: contract.clientId, sessionId: contract.sessionId,
    contractDigest: contract.digest, leaseId, result, createdAt: contract.createdAt, completedAt,
    counters: structuredClone(counters), artifacts: structuredClone(artifacts), acceptance: structuredClone(acceptance),
    reason: typeof reason === 'string' ? reason : '',
  };
  return { ...value, digest: sign(value, keyFor(contract)) };
}

export function verifyReceipt(receipt, { contract, runId, leaseId } = {}) {
  const findings = [];
  if (!receipt || !exact(receipt, [
    'acceptance', 'artifacts', 'clientId', 'completedAt', 'contractDigest', 'createdAt', 'counters', 'digest',
    'leaseId', 'reason', 'result', 'runId', 'schema', 'sessionId',
  ])) findings.push('fields');
  if (receipt?.schema !== 'bounded-runtime-receipt/v1') findings.push('schema');
  if (!contract || !validateContract(contract).valid || receipt?.contractDigest !== contract?.digest) findings.push('contract');
  if (runId !== undefined && receipt?.runId !== runId) findings.push('run');
  if (leaseId !== undefined && receipt?.leaseId !== leaseId) findings.push('lease');
  if (receipt?.clientId !== contract?.clientId || receipt?.sessionId !== contract?.sessionId) findings.push('identity');
  if (contract && !validCounters(receipt?.counters, contract)) findings.push('counters');
  if (contract && (!Array.isArray(receipt?.artifacts) || receipt.artifacts.some((artifact) => !contract.delivery.outputPaths.includes(artifact?.path)))) {
    findings.push('artifacts');
  }
  if (receipt?.result === 'completed' && (receipt?.acceptance?.passed !== true
    || receipt.acceptance.digest !== contract?.acceptanceCheck?.digest)) findings.push('acceptance');
  if (contract && receipt?.digest !== sign(unsigned(receipt), keyFor(contract))) findings.push('digest');
  return { valid: findings.length === 0, findings };
}

export function receiptDigest(receipt) { return sha256(stableSerialize(receipt)); }
