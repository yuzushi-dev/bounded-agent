import { createHash } from 'node:crypto';
import path from 'node:path';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const GATES = ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'];
const RUNTIME_VERIFIER_ID = 'bounded-runtime-verifier';
const RUNTIME_VERIFIER_DIGEST = 'sha256:6b4dd88cfd35f757be313b6d40a7644a793f7706a7b5308a3b1a251a61f9a73d';

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function stableSerialize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  throw new Error('unsupported contract value');
}

export function sha256(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value : stableSerialize(value);
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function exact(value, required, optional = []) {
  return plain(value)
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function canonicalIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function safeText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && SAFE_TEXT.test(value);
}

function safeAbsolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0');
}

function workerSpec(value) {
  return exact(value, ['args', 'command']) && safeAbsolute(value.command)
    && !/(?:^|\/)(?:ba|z)?sh|dash$|(?:curl|wget|ssh|scp)$/.test(value.command)
    && Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string' && !/[\u0000-\u001f\u007f]/.test(arg));
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !value.split('/').some((part) => part === '.' || part === '..')
    && !value.startsWith('receipts/') && value !== 'receipts';
}

function safeReadRelative(value) {
  return safeRelative(value) && !value.split('/').some((part) => /^(?:\.ssh|\.aws|\.config|\.env(?:\.|$)|credentials?|secrets?|id_rsa|id_ed25519)$/i.test(part));
}

function identity(value) {
  return plain(value) && Object.keys(value).sort().join(',') === 'digest,id,value'
    && ID.test(value.id || '') && safeText(value.value) && DIGEST.test(value.digest || '')
    && value.digest === sha256(value.value);
}

function runId(sessionId, toolCallId) {
  return `run_${createHash('sha256').update(sessionId).update('\0').update(toolCallId).digest('hex').slice(0, 24)}`;
}

function unsigned(contract) {
  const { digest: _digest, ...value } = contract;
  return value;
}

function findingsFor(contract, { now } = {}) {
  const findings = [];
  const add = (condition, code) => { if (!condition) findings.push({ code }); };
  add(plain(contract), 'shape');
  if (!plain(contract)) return findings;

  const fields = [
    'allowFallback', 'boundedContext', 'budgets', 'clientId', 'createdAt', 'deadline', 'delivery', 'digest',
    'expiresAt', 'phase', 'requiredGates', 'retries', 'routing', 'runId', 'schema', 'sessionId', 'stopPolicy',
    'acceptanceCheck', 'cwd', 'task', 'toolCallId', 'trigger', 'trustedStateDigest', 'verifier', 'worker', 'writeScope',
  ];
  add(Object.keys(contract).sort().join(',') === [...fields].sort().join(','), 'fields');
  add(contract.schema === 'bounded-runtime-contract/v1', 'schema');
  add(safeAbsolute(contract.cwd), 'cwd');
  add(ID.test(contract.clientId || '') && ID.test(contract.sessionId || ''), 'identity');
  add(ID.test(contract.toolCallId || '') && contract.runId === runId(contract.sessionId, contract.toolCallId), 'run-id');
  add(identity(contract.trigger) && identity(contract.task) && identity(contract.acceptanceCheck), 'objectives');
  add(exact(contract.verifier, ['id', 'digest']) && contract.verifier.id === RUNTIME_VERIFIER_ID
    && contract.verifier.digest === RUNTIME_VERIFIER_DIGEST, 'verifier');
  add(workerSpec(contract.worker), 'worker');
  add(DIGEST.test(contract.trustedStateDigest || ''), 'trusted-state');

  const context = contract.boundedContext;
  add(exact(context, ['maxBytes', 'readPaths', 'sessionPath'])
    && safeRelative(context.sessionPath) && Array.isArray(context.readPaths)
    && context.readPaths.every(safeReadRelative) && new Set(context.readPaths).size === context.readPaths.length
    && Number.isSafeInteger(context.maxBytes) && context.maxBytes > 0
    && context.maxBytes <= contract.budgets?.maxReadBytes, 'context');

  const scope = contract.writeScope;
  const scopeValues = [...(scope?.paths || []), ...(scope?.patchPaths || [])];
  add(exact(scope, ['patchPaths', 'paths'], ['maxFiles'])
    && Array.isArray(scope.paths) && scope.paths.length > 0 && Array.isArray(scope.patchPaths)
    && scopeValues.every(safeRelative) && new Set(scopeValues).size === scopeValues.length
    && Number.isSafeInteger(scope.maxFiles) && scope.maxFiles === scopeValues.length, 'scope');

  const budgets = contract.budgets;
  const budgetFields = ['maxArtifactBytes', 'maxOutputBytes', 'maxReadBytes', 'maxRequests', 'maxWorkers'];
  add(exact(budgets, budgetFields) && budgetFields.every((key) => Number.isSafeInteger(budgets[key]) && budgets[key] > 0)
    && budgets.maxRequests >= 2 && budgets.maxWorkers === 1, 'budgets');

  const outputPaths = contract.delivery?.outputPaths;
  add(exact(contract.delivery, ['mode', 'outputPaths', 'receiptPath']) && contract.delivery.mode === 'local'
    && Array.isArray(outputPaths) && outputPaths.length > 0 && outputPaths.every((value) => scopeValues.includes(value))
    && new Set(outputPaths).size === outputPaths.length && contract.delivery.receiptPath === `receipts/${contract.runId}.json`, 'delivery');
  add(Array.isArray(contract.requiredGates) && new Set(contract.requiredGates).size === contract.requiredGates.length
    && GATES.every((gate) => contract.requiredGates.includes(gate)), 'gates');
  add(exact(contract.retries, ['request', 'semantic', 'transport', 'worker'])
    && Object.values(contract.retries).every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1), 'retries');
  add(exact(contract.stopPolicy, ['onFailure', 'partialSuccess'])
    && ['rollback', 'preserve-for-review'].includes(contract.stopPolicy.onFailure)
    && contract.stopPolicy.partialSuccess === 'block', 'stop-policy');
  add(exact(contract.routing, ['chains', 'reviewerFamily']) && typeof contract.routing.reviewerFamily === 'string'
    && Array.isArray(contract.routing.chains) && contract.routing.chains.length > 0, 'routing');
  add(contract.allowFallback === false && contract.phase === 'dispatch', 'fallback');

  const times = [contract.createdAt, contract.deadline, contract.expiresAt];
  add(times.every(canonicalIso), 'timestamps');
  if (times.every(canonicalIso)) {
    const created = Date.parse(contract.createdAt);
    const deadline = Date.parse(contract.deadline);
    const expires = Date.parse(contract.expiresAt);
    add(created < deadline && deadline === expires && expires - created <= 300_000, 'window');
    if (now !== undefined) add(canonicalIso(now) && Date.parse(now) >= created && Date.parse(now) < expires, 'fresh');
  }
  add(DIGEST.test(contract.digest || '') && contract.digest === sha256(unsigned(contract)), 'digest');
  return findings;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createContract(request, { now = new Date().toISOString() } = {}) {
  if (!plain(request) || !canonicalIso(now)) throw new Error('runtime contract request is invalid');
  if (request.externalEffects !== undefined
    && (!plain(request.externalEffects) || request.externalEffects.enabled !== false)) {
    throw new Error('external effects are disabled');
  }
  if (!Number.isSafeInteger(request.maxSeconds) || request.maxSeconds < 1 || request.maxSeconds > 300) {
    throw new Error('bounded window must be from 1 to 300 seconds');
  }
  if (!ID.test(request.clientId || '') || !ID.test(request.sessionId || '') || !ID.test(request.toolCallId || '')) {
    throw new Error('client, session, and tool call identities are invalid');
  }
  const expiresAt = new Date(Date.parse(now) + request.maxSeconds * 1000).toISOString();
  const outputPaths = request.delivery?.outputPaths;
  const contract = {
    schema: 'bounded-runtime-contract/v1',
    cwd: request.cwd,
    clientId: request.clientId,
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    runId: runId(request.sessionId, request.toolCallId),
    trigger: { id: request.trigger?.id, value: request.trigger?.value, digest: sha256(request.trigger?.value) },
    task: { id: request.task?.id, value: request.task?.value, digest: sha256(request.task?.value) },
    acceptanceCheck: {
      id: request.acceptanceCheck?.id,
      value: request.acceptanceCheck?.value,
      digest: sha256(request.acceptanceCheck?.value),
    },
    boundedContext: structuredClone(request.boundedContext),
    writeScope: structuredClone(request.writeScope),
    verifier: structuredClone(request.verifier),
    worker: structuredClone(request.worker),
    requiredGates: [...new Set(request.requiredGates || [])],
    budgets: structuredClone(request.budgets),
    delivery: { mode: request.delivery?.mode, outputPaths: structuredClone(outputPaths), receiptPath: `receipts/${runId(request.sessionId, request.toolCallId)}.json` },
    routing: structuredClone(request.routing),
    trustedStateDigest: request.trustedStateDigest,
    retries: structuredClone(request.retries),
    stopPolicy: structuredClone(request.stopPolicy),
    allowFallback: false,
    phase: 'dispatch',
    createdAt: now,
    deadline: expiresAt,
    expiresAt,
  };
  const report = findingsFor({ ...contract, digest: sha256(contract) }, { now });
  if (report.length > 0) throw new Error(`invalid runtime contract: ${report.map(({ code }) => code).join(', ')}`);
  return freeze({ ...contract, digest: sha256(contract) });
}

export function validateContract(contract, options = {}) {
  const findings = findingsFor(contract, options);
  return { valid: findings.length === 0, findings };
}

export { stableSerialize, RUNTIME_VERIFIER_DIGEST, RUNTIME_VERIFIER_ID };
