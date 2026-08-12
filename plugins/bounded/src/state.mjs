import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { containsCredentialMaterial, sha256, stableSerialize, validateContract } from './contract.mjs';
import { createReceipt, verifyReceipt } from './receipt.mjs';

const STATE_KEYS = [
  'approvalId', 'artifactBytes', 'contractDigest', 'cwd', 'hookDigest', 'outputBytes', 'pending', 'readBytes',
  'requestCount', 'runId', 'schema', 'sessionId', 'startedAt', 'status', 'updatedAt',
];
const PENDING_KEYS = ['artifactBytes', 'startedAt', 'toolName', 'toolUseId'];
const HEARTBEAT_KEYS = ['cwd', 'hookDigest', 'recordedAt', 'schema', 'sessionId'];
const APPROVAL_KEYS = [
  'approvalId', 'contractDigest', 'cwd', 'expiresAt', 'hookDigest', 'issuedAt', 'schema', 'sessionId', 'usedAt',
];
const JOURNAL_KEYS = ['approval', 'approvalPath', 'contract', 'marker', 'receipt', 'receiptPath', 'schema', 'state'];
const COUNTERS = ['readBytes', 'artifactBytes', 'outputBytes'];
const TERMINAL_RESULTS = new Map([
  ['accepted', 'completed'],
  ['rejected', 'completed'],
  ['rolled-back', 'rolled-back'],
  ['expired', 'expired'],
  ['budget-exceeded', 'budget-exceeded'],
]);
const HEARTBEAT_MAX_AGE_MS = 60_000;
const STALE_LOCK_MS = 30_000;

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

function absolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\u0000')) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return value;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function lexists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { return error.code !== 'ENOENT'; }
}

function privateDirectory(directory, label) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { throw new Error(`${label} is unavailable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
    || (stat.mode & 0o077) !== 0 || (currentUid() !== undefined && stat.uid !== currentUid())) {
    throw new Error(`${label} is unsafe`);
  }
}

function realDirectory(directory, label) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { throw new Error(`${label} is unavailable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} is unsafe`);
  }
}

function ensureRealAncestors(directory, label) {
  const missing = [];
  let current = directory;
  while (!lexists(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`${label} is unavailable`);
    current = parent;
  }
  realDirectory(current, label);
  for (const item of missing.reverse()) fs.mkdirSync(item, { mode: 0o700 });
}

function ensurePrivateDirectory(directory, label) {
  absolutePath(directory, label);
  if (!lexists(directory)) {
    ensureRealAncestors(path.dirname(directory), `${label} parent`);
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  privateDirectory(directory, label);
}

function privateFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`${label} is unavailable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file
    || (stat.mode & 0o077) !== 0 || (currentUid() !== undefined && stat.uid !== currentUid())) {
    throw new Error(`${label} is unsafe`);
  }
}

function readJson(file, label) {
  if (!lexists(file)) return null;
  privateFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${label} is malformed`); }
}

function syncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch {}
}

function writeJson(file, value, label) {
  const directory = path.dirname(file);
  privateDirectory(directory, `${label} parent`);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const content = `${stableSerialize(value)}\n`;
  let descriptor;
  try {
    if (lexists(file)) privateFile(file, label);
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw new Error(`${label} write failed: ${error.message}`);
  }
}

function writeExclusiveJson(file, value, label) {
  const directory = path.dirname(file);
  privateDirectory(directory, `${label} parent`);
  const content = `${stableSerialize(value)}\n`;
  let descriptor;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(file, flags, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw new Error(`${label} create failed: ${error.message}`);
  }
}

function removeLock(file, descriptor) {
  try {
    const expected = fs.fstatSync(descriptor);
    const actual = fs.lstatSync(file);
    if (actual.dev === expected.dev && actual.ino === expected.ino) fs.unlinkSync(file);
  } catch {}
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function removeStaleLock(file) {
  try {
    privateFile(file, 'bounded state lock');
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < STALE_LOCK_MS) return false;
    let payload;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { payload = {}; }
    if (processAlive(payload.pid)) return false;
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function validateSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) throw new Error('session id is invalid');
  return value;
}

function validateHookDigest(value) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('hook digest is invalid');
  return value;
}

function validateRunId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('run id is invalid');
  return value;
}

function validateCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
}

function validatePending(value) {
  if (!Array.isArray(value) || value.some((entry) => !exactKeys(entry, PENDING_KEYS)
    || !Number.isSafeInteger(entry.artifactBytes) || entry.artifactBytes < 0
    || typeof entry.toolName !== 'string' || !entry.toolName
    || typeof entry.toolUseId !== 'string' || !entry.toolUseId
    || !Number.isFinite(Date.parse(entry.startedAt)))) throw new Error('pending reservations are invalid');
}

function validateState(state, contract) {
  if (!exactKeys(state, STATE_KEYS)
    || state.schema !== 'bounded-state/v2'
    || !['active', 'completed', 'rolled-back', 'expired', 'budget-exceeded'].includes(state.status)
    || state.cwd !== contract.cwd
    || state.contractDigest !== contract.digest
    || !validateRunId(state.runId)
    || !validateSessionId(state.sessionId)
    || !validateHookDigest(state.hookDigest)
    || typeof state.approvalId !== 'string' || !/^[a-f0-9]{64}$/.test(state.approvalId)
    || !canonicalIso(state.startedAt, 'state startedAt')
    || !canonicalIso(state.updatedAt, 'state updatedAt')
    || !Number.isSafeInteger(state.requestCount) || state.requestCount < 0
    || COUNTERS.some((name) => !Number.isSafeInteger(state[name]) || state[name] < 0)) {
    throw new Error('persisted state is invalid');
  }
  validatePending(state.pending);
  if (state.pending.length > state.requestCount || containsCredentialMaterial(state)) throw new Error('persisted state is invalid');
  return state;
}

function validateHeartbeat(heartbeat) {
  if (!exactKeys(heartbeat, HEARTBEAT_KEYS)
    || heartbeat.schema !== 'bounded-heartbeat/v1'
    || typeof heartbeat.cwd !== 'string' || !heartbeat.cwd
    || !validateSessionId(heartbeat.sessionId)
    || !validateHookDigest(heartbeat.hookDigest)) throw new Error('heartbeat is invalid');
  canonicalIso(heartbeat.recordedAt, 'heartbeat recordedAt');
  return heartbeat;
}

function validateApproval(approval) {
  if (!exactKeys(approval, APPROVAL_KEYS)
    || approval.schema !== 'bounded-approval/v1'
    || typeof approval.approvalId !== 'string' || !/^[a-f0-9]{64}$/.test(approval.approvalId)
    || !/^sha256:[a-f0-9]{64}$/.test(approval.contractDigest)
    || typeof approval.cwd !== 'string' || !approval.cwd
    || !validateSessionId(approval.sessionId)
    || !validateHookDigest(approval.hookDigest)
    || approval.usedAt !== null && typeof approval.usedAt !== 'string') throw new Error('approval is invalid');
  canonicalIso(approval.issuedAt, 'approval issuedAt');
  canonicalIso(approval.expiresAt, 'approval expiresAt');
  if (approval.usedAt !== null) canonicalIso(approval.usedAt, 'approval usedAt');
  if (Date.parse(approval.expiresAt) <= Date.parse(approval.issuedAt)) throw new Error('approval expiry is invalid');
  return approval;
}

function emptyStatus(cwd) {
  return { status: 'inactive', active: false, cwd, contractDigest: null, expiresAt: null };
}

function copy(value) {
  return structuredClone(value);
}

export function defaultStateRoot({ home = os.homedir(), env = process.env } = {}) {
  const pluginData = env.PLUGIN_DATA;
  const configured = env.BOUNDED_STATE_ROOT;
  if (pluginData !== undefined && configured !== undefined
    && absolutePath(pluginData, 'PLUGIN_DATA') !== absolutePath(configured, 'BOUNDED_STATE_ROOT')) {
    throw new Error('PLUGIN_DATA and BOUNDED_STATE_ROOT must identify the same directory');
  }
  if (pluginData !== undefined) return absolutePath(pluginData, 'PLUGIN_DATA');
  if (configured !== undefined) return absolutePath(configured, 'BOUNDED_STATE_ROOT');
  const base = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(absolutePath(base, 'state base'), 'bounded');
}

export function createStateStore({ root } = {}) {
  const explicitRoot = root !== undefined;
  const stateRoot = absolutePath(explicitRoot ? root : defaultStateRoot(), 'state root');
  const environmentConfigured = process.env.PLUGIN_DATA !== undefined || process.env.BOUNDED_STATE_ROOT !== undefined;
  if (explicitRoot && environmentConfigured && stateRoot !== defaultStateRoot()) {
    throw new Error('explicit state root must match PLUGIN_DATA/BOUNDED_STATE_ROOT');
  }
  ensurePrivateDirectory(stateRoot, 'state root');

  function paths(cwd) {
    const project = validateProject(cwd);
    const id = sha256(project).slice('sha256:'.length);
    const projectRoot = path.join(stateRoot, id);
    return {
      root: stateRoot,
      id,
      marker: path.join(stateRoot, `${id}.known.json`),
      project: projectRoot,
      cwd: project,
      contract: path.join(projectRoot, 'contract.json'),
      state: path.join(projectRoot, 'state.json'),
      lock: path.join(projectRoot, 'lock'),
      journal: path.join(projectRoot, 'journal.json'),
      receiptKey: path.join(projectRoot, 'receipt-key'),
      receipts: path.join(projectRoot, 'receipts'),
      approvals: path.join(projectRoot, 'approvals'),
      heartbeats: path.join(projectRoot, 'heartbeats'),
    };
  }

  function markerExists(projectPaths) {
    if (!lexists(projectPaths.marker)) return false;
    privateFile(projectPaths.marker, 'bounded activation marker');
    return true;
  }

  function prepare(projectPaths) {
    ensurePrivateDirectory(stateRoot, 'state root');
    if (!lexists(projectPaths.project)) {
      if (markerExists(projectPaths)) throw new Error('activated bounded state is unavailable');
      ensurePrivateDirectory(projectPaths.project, 'project state directory');
    }
    privateDirectory(projectPaths.project, 'project state directory');
    for (const [directory, label] of [[projectPaths.receipts, 'receipt directory'], [projectPaths.approvals, 'approval directory'], [projectPaths.heartbeats, 'heartbeat directory']]) {
      if (!lexists(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      privateDirectory(directory, label);
    }
  }

  function acquireLock(projectPaths) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = fs.openSync(projectPaths.lock, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        fs.fsyncSync(descriptor);
        return descriptor;
      } catch (error) {
        if (error.code !== 'EEXIST' || !removeStaleLock(projectPaths.lock)) {
          if (error.code === 'EEXIST') throw new Error('bounded state lock is unavailable');
          throw error;
        }
      }
    }
    throw new Error('bounded state lock is unavailable');
  }

  function recover(projectPaths) {
    const journal = readJson(projectPaths.journal, 'bounded state journal');
    if (journal === null) return;
    if (!exactKeys(journal, JOURNAL_KEYS) || journal.schema !== 'bounded-journal/v1' || !journal.contract || !journal.state) {
      throw new Error('bounded state journal is invalid');
    }
    validateContract(journal.contract);
    validateState(journal.state, journal.contract);
    if (journal.receipt !== null) {
      const receiptPath = journal.receiptPath;
      if (typeof receiptPath !== 'string' || path.dirname(receiptPath) !== projectPaths.receipts) throw new Error('bounded receipt path is invalid');
      const receiptCheck = verifyReceipt(journal.receipt, {
        contract: journal.contract,
        runId: journal.state.runId,
        receiptKey: receiptKey(projectPaths),
      });
      if (!receiptCheck.valid) throw new Error(`bounded receipt is invalid: ${receiptCheck.reason}`);
      writeJson(receiptPath, journal.receipt, 'bounded receipt');
    }
    if (journal.marker !== null) {
      if (!exactKeys(journal.marker, ['createdAt', 'cwd', 'schema'])
        || journal.marker.schema !== 'bounded-known/v1' || journal.marker.cwd !== projectPaths.cwd) {
        throw new Error('bounded activation marker is invalid');
      }
      if (!lexists(projectPaths.marker)) writeExclusiveJson(projectPaths.marker, journal.marker, 'bounded activation marker');
      else markerExists(projectPaths);
    }
    if (journal.approval !== null) {
      const approvalPath = journal.approvalPath;
      if (typeof approvalPath !== 'string' || path.dirname(approvalPath) !== projectPaths.approvals) throw new Error('bounded approval path is invalid');
      validateApproval(journal.approval);
      writeJson(approvalPath, journal.approval, 'bounded approval');
    }
    writeJson(projectPaths.contract, journal.contract, 'bounded contract');
    writeJson(projectPaths.state, journal.state, 'bounded state');
    fs.unlinkSync(projectPaths.journal);
    syncDirectory(projectPaths.project);
  }

  function withLock(projectPaths, callback) {
    prepare(projectPaths);
    const descriptor = acquireLock(projectPaths);
    try {
      recover(projectPaths);
      return callback();
    } finally {
      removeLock(projectPaths.lock, descriptor);
      fs.closeSync(descriptor);
    }
  }

  function load(projectPaths) {
    recover(projectPaths);
    const contract = readJson(projectPaths.contract, 'bounded contract');
    const state = readJson(projectPaths.state, 'bounded state');
    if (contract === null && state === null) return null;
    if (contract === null || state === null) throw new Error('bounded state is incomplete');
    validateContract(contract);
    validateState(state, contract);
    return { contract, state };
  }

  function summary(bundle, now) {
    return {
      status: bundle.state.status,
      active: bundle.state.status === 'active',
      cwd: bundle.contract.cwd,
      contractDigest: bundle.contract.digest,
      expiresAt: bundle.contract.expiresAt,
      runId: bundle.state.runId,
      sessionId: bundle.state.sessionId,
      requestCount: bundle.state.requestCount,
      readBytes: bundle.state.readBytes,
      artifactBytes: bundle.state.artifactBytes,
      outputBytes: bundle.state.outputBytes,
      pendingCount: bundle.state.pending.length,
      updatedAt: bundle.state.updatedAt,
      now,
    };
  }

  function validateProject(cwd) {
    absolutePath(cwd, 'project cwd');
    let stat;
    try { stat = fs.lstatSync(cwd); } catch { throw new Error('project cwd is unavailable'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(cwd) !== cwd) throw new Error('project cwd must be a real directory');
    return cwd;
  }

  function heartbeatPath(projectPaths, sessionId) {
    return path.join(projectPaths.heartbeats, `heartbeat-${sha256(sessionId).slice('sha256:'.length)}.json`);
  }

  function readHeartbeatInternal(projectPaths, sessionId) {
    if (!lexists(projectPaths.heartbeats)) return null;
    privateDirectory(projectPaths.heartbeats, 'heartbeat directory');
    if (sessionId) return readJson(heartbeatPath(projectPaths, sessionId), 'bounded heartbeat');
    const candidates = fs.readdirSync(projectPaths.heartbeats)
      .filter((name) => name.startsWith('heartbeat-') && name.endsWith('.json'))
      .map((name) => readJson(path.join(projectPaths.heartbeats, name), 'bounded heartbeat'))
      .filter(Boolean)
      .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
    return candidates[0] ?? null;
  }

  function freshHeartbeat(projectPaths, sessionId, hookDigest, now) {
    const heartbeat = readHeartbeatInternal(projectPaths, sessionId);
    if (!heartbeat) throw new Error('trusted bounded hook heartbeat is unavailable');
    validateHeartbeat(heartbeat);
    if (heartbeat.cwd !== projectPaths.cwd || (sessionId !== undefined && heartbeat.sessionId !== sessionId) || heartbeat.hookDigest !== hookDigest
      || Math.abs(Date.parse(now) - Date.parse(heartbeat.recordedAt)) > HEARTBEAT_MAX_AGE_MS) {
      throw new Error('trusted bounded hook heartbeat is stale or mismatched');
    }
    return heartbeat;
  }

  function receiptKey(projectPaths) {
    if (!lexists(projectPaths.receiptKey)) {
      writeExclusiveJson(projectPaths.receiptKey, { key: crypto.randomBytes(32).toString('base64') }, 'receipt key');
    }
    privateFile(projectPaths.receiptKey, 'receipt key');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(projectPaths.receiptKey, 'utf8')); } catch { throw new Error('receipt key is malformed'); }
    if (typeof parsed.key !== 'string') throw new Error('receipt key is malformed');
    const key = Buffer.from(parsed.key, 'base64');
    if (key.length < 16) throw new Error('receipt key is malformed');
    return key;
  }

  function approvalPath(projectPaths, value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.dirname(value) !== projectPaths.approvals) {
      throw new Error('approval path is invalid');
    }
    return value;
  }

  function commit(projectPaths, { contract, state, receipt = null, approval = null, approvalPath: usedApprovalPath = null, marker = null }) {
    const receiptPath = receipt
      ? path.join(projectPaths.receipts, `receipt-${state.runId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`)
      : null;
    const journal = {
      schema: 'bounded-journal/v1',
      contract,
      state,
      marker,
      receipt,
      receiptPath,
      approval,
      approvalPath: usedApprovalPath,
    };
    writeJson(projectPaths.journal, journal, 'bounded state journal');
    recover(projectPaths);
    return receiptPath;
  }

  function validateActive(bundle, now, sessionId) {
    if (!bundle) throw new Error('bounded contract is unavailable');
    if (bundle.state.status !== 'active') throw new Error('bounded contract is not active');
    if (sessionId !== undefined && bundle.state.sessionId !== validateSessionId(sessionId)) throw new Error('bounded session does not match');
    if (Date.parse(now) >= Date.parse(bundle.contract.expiresAt)) {
      transition(bundle, now, 'expired');
      throw new Error('bounded contract is expired');
    }
    return bundle;
  }

  function transition(bundle, now, result, acceptanceRef = '') {
    const projectPaths = paths(bundle.contract.cwd);
    const nextState = { ...bundle.state, status: TERMINAL_RESULTS.get(result), pending: [], updatedAt: now };
    const receipt = createReceipt({
      contract: bundle.contract,
      state: bundle.state,
      result,
      now,
      acceptanceRef: result === 'expired' || result === 'budget-exceeded' ? '' : acceptanceRef || 'operator transition',
      receiptKey: receiptKey(projectPaths),
    });
    commit(projectPaths, { contract: bundle.contract, state: nextState, receipt });
    return { ...summary({ contract: bundle.contract, state: nextState }, now), receipt };
  }

  return Object.freeze({
    paths,

    recordHeartbeat(cwd, { sessionId, hookDigest, now = new Date().toISOString() } = {}) {
      canonicalIso(now, 'now');
      const projectPaths = paths(cwd);
      validateSessionId(sessionId);
      validateHookDigest(hookDigest);
      const heartbeat = { schema: 'bounded-heartbeat/v1', cwd: projectPaths.cwd, sessionId, hookDigest, recordedAt: now };
      validateHeartbeat(heartbeat);
      return withLock(projectPaths, () => {
        writeJson(heartbeatPath(projectPaths, sessionId), heartbeat, 'bounded heartbeat');
        return copy(heartbeat);
      });
    },

    readHeartbeat(cwd, sessionId) {
      const projectPaths = paths(cwd);
      if (!lexists(projectPaths.project)) return null;
      return copy(readHeartbeatInternal(projectPaths, sessionId));
    },

    createApproval(contract, { now = new Date().toISOString(), hookDigest, sessionId } = {}) {
      canonicalIso(now, 'now');
      validateContract(contract, { now });
      validateHookDigest(hookDigest);
      const projectPaths = paths(contract.cwd);
      return withLock(projectPaths, () => {
        const existing = load(projectPaths);
        if (existing?.state.status === 'active') throw new Error('another bounded contract is active');
        const heartbeat = freshHeartbeat(projectPaths, sessionId ?? undefined, hookDigest, now);
        const approval = {
          schema: 'bounded-approval/v1',
          approvalId: crypto.randomBytes(32).toString('hex'),
          cwd: contract.cwd,
          contractDigest: contract.digest,
          sessionId: heartbeat.sessionId,
          hookDigest,
          issuedAt: now,
          expiresAt: new Date(Math.min(Date.parse(contract.expiresAt), Date.parse(now) + 120_000)).toISOString(),
          usedAt: null,
        };
        const target = path.join(projectPaths.approvals, `approval-${approval.approvalId}.json`);
        writeExclusiveJson(target, approval, 'bounded approval');
        return { approval: copy(approval), approvalPath: target };
      });
    },

    read(cwd) {
      const projectPaths = paths(cwd);
      if (!lexists(projectPaths.project)) {
        if (markerExists(projectPaths)) throw new Error('activated bounded state is unavailable');
        return null;
      }
      return withLock(projectPaths, () => copy(load(projectPaths)));
    },

    activate(contract, { approvalPath: suppliedApprovalPath, hookDigest, now = new Date().toISOString() } = {}) {
      canonicalIso(now, 'now');
      validateContract(contract, { now });
      validateHookDigest(hookDigest);
      const projectPaths = paths(contract.cwd);
      return withLock(projectPaths, () => {
        const target = approvalPath(projectPaths, suppliedApprovalPath);
        const approval = readJson(target, 'bounded approval');
        if (!approval) throw new Error('bounded approval is unavailable');
        validateApproval(approval);
        const heartbeat = freshHeartbeat(projectPaths, approval.sessionId, hookDigest, now);
        if (approval.contractDigest !== contract.digest || approval.cwd !== contract.cwd || approval.hookDigest !== hookDigest
          || approval.usedAt !== null || Date.parse(now) >= Date.parse(approval.expiresAt)) {
          throw new Error('bounded approval is invalid or already used');
        }
        if (heartbeat.sessionId !== approval.sessionId) throw new Error('bounded session does not match approval');
        const existing = load(projectPaths);
        if (existing?.state.status === 'active') throw new Error('another bounded contract is active');
        const state = {
          schema: 'bounded-state/v2',
          cwd: contract.cwd,
          contractDigest: contract.digest,
          runId: crypto.randomBytes(32).toString('hex'),
          sessionId: approval.sessionId,
          hookDigest,
          approvalId: approval.approvalId,
          status: 'active',
          startedAt: now,
          updatedAt: now,
          requestCount: 0,
          readBytes: 0,
          artifactBytes: 0,
          outputBytes: 0,
          pending: [],
        };
        validateState(state, contract);
        const usedApproval = { ...approval, usedAt: now };
        commit(projectPaths, {
          contract,
          state,
          approval: usedApproval,
          approvalPath: target,
          marker: { schema: 'bounded-known/v1', cwd: projectPaths.cwd, createdAt: now },
        });
        return copy(summary({ contract, state }, now));
      });
    },

    status(cwd, { now = new Date().toISOString() } = {}) {
      canonicalIso(now, 'now');
      const projectPaths = paths(cwd);
      if (!lexists(projectPaths.project)) {
        if (markerExists(projectPaths)) throw new Error('activated bounded state is unavailable');
        return emptyStatus(projectPaths.cwd);
      }
      return withLock(projectPaths, () => {
        const bundle = load(projectPaths);
        if (!bundle) return emptyStatus(projectPaths.cwd);
        if (bundle.state.status === 'active' && Date.parse(now) >= Date.parse(bundle.contract.expiresAt)) return transition(bundle, now, 'expired');
        return copy(summary(bundle, now));
      });
    },

    reserve(cwd, { now = new Date().toISOString(), sessionId, toolUseId, toolName, artifactBytes = 0 } = {}) {
      canonicalIso(now, 'now');
      validateSessionId(sessionId);
      if (typeof toolUseId !== 'string' || !toolUseId.trim()) throw new Error('tool use id is required');
      if (typeof toolName !== 'string' || !toolName.trim()) throw new Error('tool name is required');
      validateCounter(artifactBytes, 'artifact reservation');
      const projectPaths = paths(cwd);
      return withLock(projectPaths, () => {
        const bundle = validateActive(load(projectPaths), now, sessionId);
        if (bundle.state.pending.some((entry) => entry.toolUseId === toolUseId)) throw new Error('tool use is already reserved');
        const next = {
          requestCount: bundle.state.requestCount + 1,
          readBytes: bundle.state.readBytes,
          artifactBytes: bundle.state.artifactBytes + artifactBytes,
          outputBytes: bundle.state.outputBytes,
        };
        if (next.requestCount > bundle.contract.budgets.maxRequests) throw new Error('request budget exceeded');
        if (next.artifactBytes > bundle.contract.budgets.maxArtifactBytes) throw new Error('artifact budget exceeded');
        const state = {
          ...bundle.state,
          ...next,
          pending: [...bundle.state.pending, { toolUseId, toolName, artifactBytes, startedAt: now }],
          updatedAt: now,
        };
        commit(projectPaths, { contract: bundle.contract, state });
        return copy(state);
      });
    },

    settle(cwd, { now = new Date().toISOString(), sessionId, toolUseId, readBytes = 0, outputBytes = 0 } = {}) {
      canonicalIso(now, 'now');
      validateSessionId(sessionId);
      if (typeof toolUseId !== 'string' || !toolUseId.trim()) throw new Error('tool use id is required');
      validateCounter(readBytes, 'read bytes');
      validateCounter(outputBytes, 'output bytes');
      const projectPaths = paths(cwd);
      return withLock(projectPaths, () => {
        const bundle = validateActive(load(projectPaths), now, sessionId);
        const pending = bundle.state.pending.find((entry) => entry.toolUseId === toolUseId);
        if (!pending) throw new Error('tool use reservation is unavailable');
        const next = {
          readBytes: bundle.state.readBytes + readBytes,
          outputBytes: bundle.state.outputBytes + outputBytes,
        };
        if (next.readBytes > bundle.contract.budgets.maxReadBytes || next.outputBytes > bundle.contract.budgets.maxOutputBytes) {
          transition(bundle, now, 'budget-exceeded');
          throw new Error('bounded output budget exceeded');
        }
        const state = {
          ...bundle.state,
          ...next,
          pending: bundle.state.pending.filter((entry) => entry.toolUseId !== toolUseId),
          updatedAt: now,
        };
        commit(projectPaths, { contract: bundle.contract, state });
        return copy(state);
      });
    },

    rollback(cwd, { now = new Date().toISOString(), sessionId, reason = 'operator rollback' } = {}) {
      canonicalIso(now, 'now');
      validateSessionId(sessionId);
      if (typeof reason !== 'string' || !reason.trim() || containsCredentialMaterial(reason)) throw new Error('rollback reason is invalid');
      const projectPaths = paths(cwd);
      if (!lexists(projectPaths.project)) {
        if (markerExists(projectPaths)) throw new Error('activated bounded state is unavailable');
        return emptyStatus(projectPaths.cwd);
      }
      return withLock(projectPaths, () => {
        const bundle = load(projectPaths);
        if (!bundle || bundle.state.status !== 'active') return bundle ? copy(summary(bundle, now)) : emptyStatus(projectPaths.cwd);
        if (bundle.state.sessionId !== sessionId) throw new Error('bounded session does not match');
        return transition(bundle, now, 'rolled-back', reason.trim());
      });
    },

    complete(cwd, { now = new Date().toISOString(), sessionId, result, acceptanceRef } = {}) {
      canonicalIso(now, 'now');
      validateSessionId(sessionId);
      if (!['accepted', 'rejected'].includes(result)) throw new Error('completion result is invalid');
      if (typeof acceptanceRef !== 'string' || !acceptanceRef.trim()) throw new Error('acceptance reference is required');
      const projectPaths = paths(cwd);
      return withLock(projectPaths, () => {
        const bundle = validateActive(load(projectPaths), now, sessionId);
        if (bundle.state.pending.length > 0) throw new Error('cannot complete while post-tool reconciliation is pending');
        const next = { ...bundle.state, updatedAt: now };
        return transition({ contract: bundle.contract, state: next }, now, result, acceptanceRef.trim());
      });
    },
  });
}
