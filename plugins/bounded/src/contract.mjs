import crypto from 'node:crypto';
import path from 'node:path';

const CONTRACT_KEYS = [
  'acceptanceCheck', 'budgets', 'createdAt', 'cwd', 'digest', 'expiresAt', 'policy', 'schema', 'scope', 'task',
];
const SCOPE_KEYS = ['maxFiles', 'paths'];
const BUDGET_KEYS = ['maxArtifactBytes', 'maxOutputBytes', 'maxReadBytes', 'maxRequests', 'maxSeconds'];
const POLICY_KEYS = ['externalEffects', 'finalGate', 'prohibitedEffects'];
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_SCOPE_FILES = 128;
const MAX_BYTE_BUDGET = 64 * 1024 * 1024;
const CREDENTIAL_KEY = /(?:auth(?:entication|orization)?|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|cookie|credential|passphrase|password|secret|session[_-]?key|token)/i;
const CREDENTIAL_VALUE = /(?:\bBearer\s+\S+|\b(?:sk|gh[opusr]|github_pat|npm|hf|glpat)-[A-Za-z0-9._-]{12,}|\bAKIA[A-Z0-9]{16}|\bAIza[0-9A-Za-z_-]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|secret|token)\s*[:=]\s*\S+)/i;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  return plainObject(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function error(message) {
  throw new Error(message);
}

function canonicalIso(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) error(`${name} must be a canonical ISO timestamp`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    error(`${name} must be nonempty bounded text`);
  }
  if (value.includes('\u0000')) error(`${name} contains an invalid character`);
  return value.trim();
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    error(`${name} must be a positive bounded integer`);
  }
  return value;
}

function normalizeCwd(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value
    || value.includes('\u0000')) error('cwd must be an absolute normalized path');
  return value;
}

function normalizeScope(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_FILES) {
    error('scope must contain 1-128 writable paths');
  }
  const paths = value.map((item) => {
    if (typeof item !== 'string' || !item || item.includes('\u0000') || item.includes('\\')
      || path.posix.isAbsolute(item) || path.win32.isAbsolute(item)) error('scope contains an unsafe path');
    const normalized = path.posix.normalize(item);
    if (normalized !== item || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      error('scope contains a traversal or non-canonical path');
    }
    return normalized;
  });
  if (new Set(paths).size !== paths.length) error('scope contains duplicate paths');
  return paths;
}

function normalizeBudgets(value) {
  if (!exactKeys(value, BUDGET_KEYS)) error('budgets are invalid');
  const budgets = {
    maxArtifactBytes: positiveInteger(value.maxArtifactBytes, 'artifact budget', MAX_BYTE_BUDGET),
    maxOutputBytes: positiveInteger(value.maxOutputBytes, 'output budget', MAX_BYTE_BUDGET),
    maxReadBytes: positiveInteger(value.maxReadBytes, 'read budget', MAX_BYTE_BUDGET),
    maxRequests: positiveInteger(value.maxRequests, 'request budget', 128),
    maxSeconds: positiveInteger(value.maxSeconds, 'maximum seconds', 300),
  };
  if (budgets.maxRequests < 2) error('requests budget must allow an independent check');
  return budgets;
}

function normalizePolicy(value) {
  if (!exactKeys(value, POLICY_KEYS)
    || value.externalEffects !== false
    || value.finalGate !== 'human-approval'
    || value.prohibitedEffects !== 'all external effects') {
    error('external effects policy is invalid');
  }
  return {
    externalEffects: false,
    finalGate: 'human-approval',
    prohibitedEffects: 'all external effects',
  };
}

export function containsCredentialMaterial(value, key = '') {
  if (CREDENTIAL_KEY.test(key)) return true;
  if (Array.isArray(value)) return value.some((item) => containsCredentialMaterial(item));
  if (plainObject(value)) {
    return Object.entries(value).some(([name, item]) => containsCredentialMaterial(item, name));
  }
  return typeof value === 'string' && CREDENTIAL_VALUE.test(value);
}

export function stableSerialize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) error('cannot serialize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  error('cannot serialize a non-plain value');
}

export function sha256(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : stableSerialize(value);
  return `sha256:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

function unsignedContract(value) {
  const { digest: _digest, ...unsigned } = value;
  return unsigned;
}

function validateContractShape(value) {
  if (!exactKeys(value, CONTRACT_KEYS) || value.schema !== 'bounded-run-contract/v1') {
    error('contract shape is invalid');
  }
  normalizeCwd(value.cwd);
  text(value.task, 'task');
  text(value.acceptanceCheck, 'acceptance check');
  if (!exactKeys(value.scope, SCOPE_KEYS)) error('scope is invalid');
  const paths = normalizeScope(value.scope.paths);
  if (value.scope.maxFiles !== paths.length) error('scope maxFiles is not bound');
  const budgets = normalizeBudgets(value.budgets);
  const policy = normalizePolicy(value.policy);
  const createdAt = canonicalIso(value.createdAt, 'createdAt');
  const expiresAt = canonicalIso(value.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) error('contract deadline is invalid');
  if (Date.parse(expiresAt) - Date.parse(createdAt) !== budgets.maxSeconds * 1000) {
    error('contract deadline is not bound to the budget');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.digest)) error('contract digest is invalid');
  if (containsCredentialMaterial(value)) error('contract contains credential material');
  return { paths, budgets, policy, createdAt, expiresAt };
}

export function validateContract(value, { now } = {}) {
  const normalized = validateContractShape(value);
  if (sha256(unsignedContract(value)) !== value.digest) error('contract digest does not match its contents');
  if (now !== undefined) {
    const current = canonicalIso(now, 'now');
    const timestamp = Date.parse(current);
    if (timestamp < Date.parse(normalized.createdAt)) error('contract is not yet valid');
    if (timestamp >= Date.parse(normalized.expiresAt)) error('contract is expired');
  }
  return true;
}

export function createContract(request, { now = new Date().toISOString() } = {}) {
  if (!plainObject(request)) error('bounded request is invalid');
  const createdAt = canonicalIso(now, 'now');
  const budgets = normalizeBudgets({
    maxArtifactBytes: request.maxArtifactBytes,
    maxOutputBytes: request.maxOutputBytes,
    maxReadBytes: request.maxReadBytes,
    maxRequests: request.maxRequests,
    maxSeconds: request.maxSeconds,
  });
  const externalEffects = request.externalEffects;
  if (externalEffects !== undefined && externalEffects !== false
    && !(plainObject(externalEffects) && Object.keys(externalEffects).length === 1 && externalEffects.enabled === false)) {
    error('external effects are disabled');
  }
  const contract = {
    schema: 'bounded-run-contract/v1',
    cwd: normalizeCwd(request.cwd),
    task: text(request.task, 'task'),
    acceptanceCheck: text(request.acceptanceCheck, 'acceptance check'),
    scope: (() => {
      const paths = normalizeScope(request.scope);
      return { paths, maxFiles: paths.length };
    })(),
    budgets,
    policy: normalizePolicy({
      externalEffects: false,
      finalGate: request.finalGate,
      prohibitedEffects: request.prohibitedEffects,
    }),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + budgets.maxSeconds * 1000).toISOString(),
  };
  if (containsCredentialMaterial(contract)) error('bounded request contains credential material');
  const result = { ...contract, digest: sha256(contract) };
  validateContract(result, { now: createdAt });
  return result;
}
