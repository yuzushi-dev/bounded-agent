import fs from 'node:fs';
import path from 'node:path';

const RUN_ID = /^run_[a-f0-9]{24}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL = new Set(['completed', 'failed', 'rolled-back', 'expired', 'preserved']);

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function privateRoot(root) {
  absolute(root, 'state root');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('state root is unsafe');
}

function runId(value) {
  if (!RUN_ID.test(value || '')) throw new Error('run id is invalid');
}

function copy(value) { return structuredClone(value); }

function sync(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    sync(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('state file is unsafe');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function statePath(root, run) { return path.join(root, `${run}.state`); }
function contractPath(root, run) { return path.join(root, `${run}.contract`); }
function journalPath(root, run) { return path.join(root, `${run}.journal`); }
function lockPath(root, run) { return path.join(root, `${run}.lock`); }

function validateEvent(event) {
  if (!event || typeof event !== 'object' || !['approve', 'activate', 'complete', 'rollback', 'fail', 'expire', 'preserve'].includes(event.type)) {
    throw new Error('state transition is invalid');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(event.contractDigest || '') || !ID.test(event.clientId || '') || !ID.test(event.sessionId || '')) {
    throw new Error('state transition binding is invalid');
  }
  if (!Number.isSafeInteger(event.counter) || event.counter < 1) throw new Error('state counter is invalid');
  if (typeof event.now !== 'string' || !Number.isFinite(Date.parse(event.now)) || new Date(event.now).toISOString() !== event.now) {
    throw new Error('state timestamp is invalid');
  }
}

export function createInitialState(contract, { now = new Date().toISOString() } = {}) {
  if (!contract?.runId || !RUN_ID.test(contract.runId)) throw new Error('contract run id is invalid');
  return {
    schema: 'bounded-runtime-state/v1',
    runId: contract.runId,
    contractDigest: contract.digest,
    clientId: contract.clientId,
    sessionId: contract.sessionId,
    status: 'planned',
    counter: 0,
    leaseId: null,
    leaseExpiresAt: null,
    startedAt: now,
    updatedAt: now,
    terminalReason: null,
  };
}

export function transition(current, event) {
  validateEvent(event);
  if (!current || current.schema !== 'bounded-runtime-state/v1' || !RUN_ID.test(current.runId)) throw new Error('state is invalid');
  if (TERMINAL.has(current.status)) throw new Error('terminal state cannot transition');
  if (event.contractDigest !== current.contractDigest || event.clientId !== current.clientId || event.sessionId !== current.sessionId) {
    throw new Error('state binding does not match');
  }
  if (event.counter !== current.counter + 1) throw new Error('state counter is not monotonic');
  if (event.type === 'approve' && current.status !== 'planned') throw new Error('invalid approval transition');
  if (event.type === 'activate' && current.status !== 'approved') throw new Error('invalid activation transition');
  if (['complete', 'rollback', 'fail', 'expire', 'preserve'].includes(event.type) && current.status !== 'running') {
    throw new Error('invalid terminal transition');
  }
  if (event.type === 'approve' && (typeof event.operatorProof !== 'string' || !event.operatorProof.trim())) {
    throw new Error('operator proof is required');
  }
  if (!['approve', 'activate'].includes(event.type)
    && (!ID.test(event.leaseId || '') || event.leaseId !== current.leaseId)) {
    throw new Error('lease binding does not match');
  }
  if (event.type === 'activate' && !ID.test(event.leaseId || '')) throw new Error('lease id is invalid');
  const status = {
    approve: 'approved', activate: 'running', complete: 'completed', rollback: 'rolled-back', fail: 'failed', expire: 'expired', preserve: 'preserved',
  }[event.type];
  return {
    ...current,
    status,
    counter: event.counter,
    leaseId: event.type === 'activate' ? event.leaseId : current.leaseId,
    leaseExpiresAt: event.leaseExpiresAt ?? current.leaseExpiresAt,
    terminalReason: TERMINAL.has(status) ? (event.reason || event.type) : null,
    updatedAt: event.now,
  };
}

export function recoverState({ root, runId: id }) {
  privateRoot(root);
  runId(id);
  const journal = readJson(journalPath(root, id));
  if (!journal) {
    const state = readJson(statePath(root, id));
    if (!state) throw new Error('state is unavailable');
    return { state, recovered: false };
  }
  if (journal.schema !== 'bounded-runtime-journal/v1' || journal.runId !== id || !journal.next) throw new Error('state journal is invalid');
  atomicWrite(statePath(root, id), journal.next);
  fs.rmSync(journalPath(root, id));
  sync(root);
  return { state: copy(journal.next), recovered: true };
}

export function createStateStore({ root }) {
  privateRoot(root);
  function writeJournal(id, { previous = null, next, contract }) {
    runId(id);
    if (!next || next.runId !== id || !contract || contract.runId !== id) throw new Error('journal payload is invalid');
    atomicWrite(journalPath(root, id), { schema: 'bounded-runtime-journal/v1', runId: id, previous, next, contract });
  }
  return Object.freeze({
    paths(id) {
      runId(id);
      return { state: statePath(root, id), contract: contractPath(root, id), journal: journalPath(root, id), lock: lockPath(root, id) };
    },
    writeContract(contract) {
      runId(contract?.runId);
      atomicWrite(contractPath(root, contract.runId), contract);
      return copy(contract);
    },
    readContract(id) { runId(id); return readJson(contractPath(root, id)); },
    writeState(state) { runId(state?.runId); atomicWrite(statePath(root, state.runId), state); return copy(state); },
    commit(id, contract, previous, next) {
      writeJournal(id, { previous, next, contract });
      return recoverState({ root, runId: id }).state;
    },
    read(id) { return recoverState({ root, runId: id }).state; },
    writeJournal,
    writeStaleLock(id, value) { runId(id); atomicWrite(lockPath(root, id), value); },
    reconcile(id) {
      runId(id);
      const file = lockPath(root, id);
      if (!fs.existsSync(file)) return { lockRemoved: false };
      let payload;
      try { payload = readJson(file); } catch { payload = null; }
      let alive = false;
      if (Number.isSafeInteger(payload?.pid) && payload.pid > 0) {
        try { process.kill(payload.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
      }
      if (alive) return { lockRemoved: false };
      fs.rmSync(file);
      sync(root);
      return { lockRemoved: true };
    },
  });
}

export { TERMINAL };
