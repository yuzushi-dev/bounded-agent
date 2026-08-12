import { createHash } from 'node:crypto';
import path from 'node:path';

import { sha256 } from './receipt.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELDS = new Set([
  'schema', 'runId', 'toolCallId', 'trigger', 'task', 'boundedContext', 'writeScope',
  'acceptanceCheck', 'verifier', 'requiredGates', 'budgets', 'deadline', 'retries', 'stopPolicy',
  'delivery', 'routing', 'trustedStateDigest', 'createdAt', 'expiresAt',
  'allowFallback', 'phase',
]);

function safePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.includes('\0')
    && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:/.test(value)
    && path.posix.normalize(value) === value
    && value.split('/').every((part) => part !== '.' && part !== '..')
    && !value.endsWith('/')
    && value !== 'receipts'
    && value !== 'manifests'
    && !value.startsWith('receipts/')
    && !value.startsWith('manifests/')
    && !value.startsWith('.omp-');
}

function identity(value, name) {
  if (!value || !SAFE_ID.test(value.id || '') || typeof value.value !== 'string' || !value.value.trim()) {
    throw new Error(`${name} identity is invalid`);
  }
  return { id: value.id, digest: sha256(value.value) };
}

function stableRunId(sessionId, toolCallId) {
  if (typeof sessionId !== 'string' || !sessionId || typeof toolCallId !== 'string' || !toolCallId) {
    throw new Error('sessionId and toolCallId are required');
  }
  return `run_${createHash('sha256').update(sessionId).update('\0').update(toolCallId).digest('hex').slice(0, 24)}`;
}

function paths(scope) {
  const values = [...(scope?.paths || []), ...(scope?.patchPaths || [])];
  if (!exactObject(scope, ['paths', 'patchPaths'], ['maxFiles'])
    || !Array.isArray(scope.paths) || scope.paths.length === 0
    || !Array.isArray(scope.patchPaths) || values.some((value) => !safePath(value))
    || new Set(values).size !== values.length
    || (scope.maxFiles !== undefined && (!Number.isInteger(scope.maxFiles) || scope.maxFiles < values.length))) {
    throw new Error('invalid write-scope');
  }
  return values;
}

function positiveBudgets(budgets) {
  const fields = ['maxReadBytes', 'maxArtifactBytes', 'maxOutputBytes', 'maxRequests', 'maxWorkers'];
  if (!exactObject(budgets, fields)
    || fields.some((field) => !Number.isInteger(budgets[field]) || budgets[field] < 1)
    || budgets.maxRequests < 2 || budgets.maxWorkers !== 1) {
    throw new Error('invalid budgets');
  }
}

function exactObject(value, fields, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key) || optional.includes(key))
    && fields.every((key) => Object.hasOwn(value, key));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createContract(request, { now, trustedStateDigest }) {
  if (!Number.isInteger(request?.maxSeconds) || request.maxSeconds < 1 || request.maxSeconds > 300) {
    throw new Error('bounded window must be from 1 to 300 seconds');
  }
  if (!DIGEST.test(trustedStateDigest || '')) throw new Error('trusted state digest is invalid');
  const outputPaths = paths(request.writeScope);
  positiveBudgets(request.budgets);
  if (request.boundedContext?.maxBytes > request.budgets.maxReadBytes) throw new Error('bounded context exceeds read budget');
  if (!safePath(request.boundedContext?.sessionPath)
    || !Array.isArray(request.boundedContext?.readPaths)
    || request.boundedContext.readPaths.length === 0
    || request.boundedContext.readPaths.some((item) => !safePath(item))) throw new Error('invalid bounded context');
  if (!request.verifier || !SAFE_ID.test(request.verifier.id || '') || !DIGEST.test(request.verifier.digest || '')) {
    throw new Error('verifier identity is invalid');
  }
  if (!Array.isArray(request.requiredGates)
    || !['sandbox', 'trusted-state', 'verifier'].every((gate) => request.requiredGates.includes(gate))) {
    throw new Error('required safety gates are missing');
  }
  if (request.delivery?.mode !== 'local'
    || !Array.isArray(request.delivery.outputPaths)
    || request.delivery.outputPaths.length !== outputPaths.length
    || new Set(request.delivery.outputPaths).size !== request.delivery.outputPaths.length
    || request.delivery.outputPaths.some((item) => !outputPaths.includes(item))) throw new Error('delivery does not match write-scope');
  if (request.stopPolicy?.onFailure !== 'rollback' || request.stopPolicy.partialSuccess !== 'block') {
    throw new Error('stop policy must rollback and block partial success');
  }
  if (!request.retries
    || Object.keys(request.retries).sort().join(',') !== 'request,semantic,transport,worker'
    || Object.values(request.retries).some((value) => !Number.isInteger(value) || value < 0 || value > 1)) {
    throw new Error('retry policy is invalid');
  }
  if (!['dispatch', 'review'].includes(request.phase ?? 'dispatch')) throw new Error('phase must be dispatch or review');
  const runId = stableRunId(request.sessionId, request.toolCallId);
  const expiresAt = new Date(Date.parse(now) + request.maxSeconds * 1000).toISOString();
  const contract = {
    schema: 'omp-run-contract/v2',
    runId,
    toolCallId: request.toolCallId,
    trigger: identity(request.trigger, 'trigger'),
    task: identity(request.task, 'task'),
    acceptanceCheck: identity(request.acceptanceCheck, 'acceptance check'),
    boundedContext: structuredClone(request.boundedContext),
    writeScope: structuredClone(request.writeScope),
    verifier: structuredClone(request.verifier),
    requiredGates: [...new Set([...request.requiredGates, 'external-effects-disabled'])],
    budgets: structuredClone(request.budgets),
    deadline: expiresAt,
    retries: structuredClone(request.retries),
    stopPolicy: structuredClone(request.stopPolicy),
    delivery: { ...structuredClone(request.delivery), receiptPath: `receipts/${runId}.json` },
    routing: structuredClone(request.routing),
    trustedStateDigest,
    createdAt: now,
    expiresAt,
    allowFallback: false,
    phase: request.phase ?? 'dispatch',
  };
  const report = validateContract(contract, { now });
  if (!report.valid) throw new Error(`invalid run contract: ${report.findings.map(({ code }) => code).join(', ')}`);
  return deepFreeze(contract);
}

export function validateContract(contract, { now } = {}) {
  const findings = [];
  const add = (condition, code) => { if (!condition) findings.push({ code }); };
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return { valid: false, findings: [{ code: 'contract-type' }] };
  }
  add(Object.keys(contract).every((key) => FIELDS.has(key)) && [...FIELDS].every((key) => Object.hasOwn(contract, key)), 'fields');
  add(contract.schema === 'omp-run-contract/v2', 'schema');
  add(/^run_[a-f0-9]{24}$/.test(contract.runId || ''), 'run-id');
  add(typeof contract.toolCallId === 'string' && /^[^\s\x00-\x1f\x7f]{1,128}$/.test(contract.toolCallId), 'tool-call-id');
  for (const name of ['trigger', 'task', 'acceptanceCheck', 'verifier']) {
    add(exactObject(contract[name], ['id', 'digest'])
      && SAFE_ID.test(contract[name]?.id || '') && DIGEST.test(contract[name]?.digest || ''), name);
  }
  let outputPaths = [];
  try { outputPaths = paths(contract.writeScope); } catch { findings.push({ code: 'write-scope' }); }
  add(Array.isArray(contract.requiredGates)
    && contract.requiredGates.every((gate) => typeof gate === 'string' && gate.length > 0)
    && new Set(contract.requiredGates).size === contract.requiredGates.length
    && ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled']
      .every((gate) => contract.requiredGates.includes(gate)), 'gates');
  try { positiveBudgets(contract.budgets); } catch { findings.push({ code: 'budgets' }); }
  add(exactObject(contract.boundedContext, ['sessionPath', 'readPaths', 'maxBytes'])
    && safePath(contract.boundedContext.sessionPath)
    && Array.isArray(contract.boundedContext.readPaths)
    && contract.boundedContext.readPaths.length > 0
    && contract.boundedContext.readPaths.every(safePath)
    && new Set(contract.boundedContext.readPaths).size === contract.boundedContext.readPaths.length
    && Number.isInteger(contract.boundedContext.maxBytes)
    && contract.boundedContext.maxBytes > 0
    && contract.boundedContext.maxBytes <= (contract.budgets?.maxReadBytes || 0), 'bounded-context');
  add(exactObject(contract.delivery, ['mode', 'outputPaths', 'receiptPath'])
    && contract.delivery.mode === 'local'
    && Array.isArray(contract.delivery.outputPaths)
    && contract.delivery.outputPaths.length === outputPaths.length
    && new Set(contract.delivery.outputPaths).size === contract.delivery.outputPaths.length
    && contract.delivery.outputPaths.every((item) => outputPaths.includes(item))
    && contract.delivery.receiptPath === `receipts/${contract.runId}.json`, 'delivery');
  add(exactObject(contract.stopPolicy, ['onFailure', 'partialSuccess'])
    && contract.stopPolicy.onFailure === 'rollback' && contract.stopPolicy.partialSuccess === 'block', 'stop-policy');
  add(exactObject(contract.retries, ['request', 'worker', 'transport', 'semantic'])
    && Object.keys(contract.retries).sort().join(',') === 'request,semantic,transport,worker'
    && Object.values(contract.retries).every((value) => Number.isInteger(value) && value >= 0 && value <= 1), 'retries');
  add(contract.allowFallback === false, 'fallback');
  add(['dispatch', 'review'].includes(contract.phase), 'phase');
  add(DIGEST.test(contract.trustedStateDigest || ''), 'trusted-state-digest');
  let routingValid = exactObject(contract.routing, ['reviewerFamily', 'chains'])
    && typeof contract.routing.reviewerFamily === 'string'
    && Array.isArray(contract.routing.chains) && contract.routing.chains.length > 0;
  if (routingValid) routingValid = contract.routing.chains.every((chain) => (
    exactObject(chain, ['role', 'family', 'selectors'])
      && typeof chain.role === 'string' && typeof chain.family === 'string'
      && Array.isArray(chain.selectors) && chain.selectors.length > 0
      && chain.selectors.every((selector) => typeof selector === 'string' && selector.startsWith(`${chain.family}/`))
  ));
  add(routingValid, 'routing');
  const timestamps = [contract.createdAt, contract.deadline, contract.expiresAt];
  const canonical = timestamps.every((value) => typeof value === 'string'
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  add(canonical, 'timestamps');
  if (canonical) {
    const created = Date.parse(contract.createdAt);
    const deadline = Date.parse(contract.deadline);
    const expires = Date.parse(contract.expiresAt);
    add(created < deadline && deadline <= expires && expires - created <= 300_000, 'window');
    if (now !== undefined) add(created <= Date.parse(now) && Date.parse(now) < expires, 'stale');
  }
  return { valid: findings.length === 0, findings };
}
