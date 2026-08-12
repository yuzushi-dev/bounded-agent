const METHODS = new Set(['plan', 'approve', 'activate', 'status', 'complete', 'rollback', 'doctor']);
export const PROTOCOL_VERSION = 1;

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function safe(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function walk(value) {
  if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value)) throw new Error('protocol string contains control characters');
  if (Array.isArray(value)) value.forEach(walk);
  else if (plain(value)) Object.values(value).forEach(walk);
}

export function validateRequest(value) {
  if (!plain(value) || value.version !== PROTOCOL_VERSION) throw new Error('protocol version is invalid');
  safe(value.id, 'request id');
  safe(value.clientId, 'client id');
  if (!METHODS.has(value.method) || !plain(value.params)) throw new Error('protocol method is invalid');
  walk(value);
  if (['approve', 'activate', 'complete', 'rollback'].includes(value.method)) {
    const params = value.params;
    if (!/^run_[a-f0-9]{24}$/.test(params.runId || '')) throw new Error('run id is required');
    if (!/^sha256:[a-f0-9]{64}$/.test(params.contractDigest || '')) throw new Error('contract digest is required');
    safe(params.sessionId, 'session id');
    if (!Number.isSafeInteger(params.counter) || params.counter < 1) throw new Error('counter is required');
    if (value.method === 'approve' && (typeof params.operatorProof !== 'string' || !params.operatorProof.trim())) {
      throw new Error('operator proof is required');
    }
    if (['complete', 'rollback'].includes(value.method)) safe(params.leaseId, 'lease id');
  }
  return structuredClone(value);
}

export function encodeMessage(value) {
  return `${JSON.stringify(validateRequest(value))}\n`;
}

export function decodeMessage(line) {
  if (typeof line !== 'string' || !line || !line.endsWith('\n') || line.slice(0, -1).includes('\n')) {
    throw new Error('protocol message must be one JSONL line');
  }
  let value;
  try { value = JSON.parse(line.slice(0, -1)); } catch { throw new Error('protocol JSON is invalid'); }
  return validateRequest(value);
}

export function encodeResponse(value) {
  if (!plain(value) || value.version !== PROTOCOL_VERSION) throw new Error('protocol response is invalid');
  walk(value);
  return `${JSON.stringify(value)}\n`;
}

export function decodeResponse(line) {
  if (typeof line !== 'string' || !line.endsWith('\n')) throw new Error('protocol response line is invalid');
  try {
    const value = JSON.parse(line.slice(0, -1));
    if (!plain(value) || value.version !== PROTOCOL_VERSION) throw new Error('protocol response version is invalid');
    walk(value);
    return value;
  } catch (error) { throw new Error(error instanceof Error ? error.message : 'protocol response is invalid'); }
}
