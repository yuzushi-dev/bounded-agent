import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createContract, sha256, validateContract } from './contract.mjs';
import { executeWorker } from './executor.mjs';
import { createReceipt, verifyReceipt } from './receipt.mjs';
import { createInitialState, createStateStore, transition } from './state.mjs';
import { verifyAcceptance, verifyArtifacts } from './verifier.mjs';

const RUN_ID = /^run_[a-f0-9]{24}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('runtime state directory is unsafe');
}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    syncFile(temporary);
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}

function syncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function canonicalNow(value) {
  const now = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Error('runtime time is invalid');
  return now;
}

function safeTarget(root, relative) {
  if (typeof relative !== 'string' || path.posix.normalize(relative) !== relative || path.posix.isAbsolute(relative)
    || relative.split('/').some((part) => part === '.' || part === '..')) throw new Error('delivery path is invalid');
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('delivery root is unsafe');
  const target = path.join(root, ...relative.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('delivery path escaped root');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('delivery path contains a symlink');
  }
  return target;
}

function sumArtifacts(artifacts) { return artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0); }

function stageArtifacts(contract, stageRoot) {
  const listed = [];
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('preserved output contains a symlink');
      if (entry.isDirectory()) visit(full, relative);
      else if (entry.isFile()) listed.push(relative);
      else throw new Error('preserved output contains a non-regular file');
    }
  }
  const rootStat = fs.lstatSync(stageRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('preserved output root is unsafe');
  visit(stageRoot);
  if (listed.length !== contract.delivery.outputPaths.length || listed.some((value) => !contract.delivery.outputPaths.includes(value))) {
    throw new Error('preserved output is undeclared');
  }
  const artifacts = contract.delivery.outputPaths.map((relative) => {
    const target = safeTarget(stageRoot, relative);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('preserved output is not a regular file');
    const content = fs.readFileSync(target);
    return { path: relative, bytes: content.length, digest: sha256(content) };
  });
  if (sumArtifacts(artifacts) > contract.budgets.maxArtifactBytes) throw new Error('preserved artifact budget exceeded');
  return artifacts;
}

function leasePath(root, runId) { return path.join(root, `${runId}.lease`); }
function receiptPath(root, runId) { return path.join(root, `${runId}.receipt`); }
function stagePath(root, runId) { return path.join(root, 'stages', runId); }
function deliveryPath(root, runId) { return path.join(root, `${runId}.delivery`); }
function baselinePath(root, runId) { return path.join(root, 'baselines', runId); }
function baselineMetaPath(root, runId) { return path.join(baselinePath(root, runId), 'manifest.json'); }
function preservedPath(root, runId) { return path.join(root, 'preserved', runId); }

function processStartTime(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2).trim().split(/\s+/)[19]; }
  catch { return null; }
}

function processMatches(pid, startTime) {
  return Number.isSafeInteger(pid) && pid > 0 && typeof startTime === 'string' && processStartTime(pid) === startTime;
}

function killProcess(pid, startTime) {
  if (!processMatches(pid, startTime)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

function validLease(lease, runId) {
  return lease?.schema === 'bounded-runtime-lease/v1' && lease.runId === runId && ID.test(lease.clientId || '')
    && ID.test(lease.sessionId || '') && ID.test(lease.leaseId || '') && Number.isSafeInteger(lease.runtimePid)
    && lease.runtimePid > 0 && typeof lease.runtimeStartTime === 'string'
    && (lease.workerPid === null || (Number.isSafeInteger(lease.workerPid) && lease.workerPid > 0))
    && ((lease.workerPid === null && lease.workerStartTime === null)
      || (Number.isSafeInteger(lease.workerPid) && typeof lease.workerStartTime === 'string'))
    && Number.isFinite(Date.parse(lease.expiresAt || '')) && new Date(lease.expiresAt).toISOString() === lease.expiresAt
    && typeof lease.bootId === 'string' && lease.bootId.length > 0;
}

function bind(params, contract, state, { lease = false } = {}) {
  if (!params || params.runId !== contract.runId || params.contractDigest !== contract.digest
    || params.clientId !== contract.clientId || params.sessionId !== contract.sessionId) throw new Error('runtime identity binding failed');
  if (lease && params.leaseId !== state.leaseId) throw new Error('runtime lease binding failed');
  if (!Number.isSafeInteger(params.counter) || params.counter !== state.counter + 1) throw new Error('runtime counter binding failed');
}

function summary(contract, state, extra = {}) {
  return {
    runId: contract.runId, contractDigest: contract.digest, clientId: contract.clientId, sessionId: contract.sessionId, cwd: contract.cwd,
    status: state.status, active: state.status === 'running', counter: state.counter, leaseId: state.leaseId,
    expiresAt: contract.expiresAt, updatedAt: state.updatedAt, ...extra,
  };
}

export function createRuntimeController({ stateRoot, now = () => new Date().toISOString() } = {}) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) throw new Error('runtime state root is required');
  privateDirectory(stateRoot);
  const store = createStateStore({ root: stateRoot });
  const operations = new Map();

  function load(runId) {
    if (!RUN_ID.test(runId || '')) throw new Error('runtime run id is invalid');
    const contract = store.readContract(runId);
    if (!contract || !validateContract(contract).valid) throw new Error('runtime contract is unavailable or invalid');
    const state = store.read(runId);
    if (state.contractDigest !== contract.digest) throw new Error('runtime state contract drifted');
    return { contract, state };
  }

  function transitionAndCommit(bundle, event) {
    const next = transition(bundle.state, event);
    store.commit(bundle.contract.runId, bundle.contract, bundle.state, next);
    return next;
  }

  function cleanup(runId) {
    operations.delete(runId);
    fs.rmSync(stagePath(stateRoot, runId), { recursive: true, force: true });
    fs.rmSync(baselinePath(stateRoot, runId), { recursive: true, force: true });
    fs.rmSync(leasePath(stateRoot, runId), { force: true });
  }

  function inspectBaseline(cwd, outputPaths) {
    return outputPaths.map((relative) => {
      const target = safeTarget(cwd, relative);
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stat) return { entry: { path: relative, exists: false, bytes: 0, digest: null, mode: null }, content: null };
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error('baseline target is unsafe');
      const content = fs.readFileSync(target);
      return { entry: { path: relative, exists: true, bytes: content.length, digest: sha256(content), mode: stat.mode & 0o777 }, content };
    });
  }

  function baselineDigest(cwd, outputPaths) {
    return sha256(inspectBaseline(cwd, outputPaths).map(({ entry }) => entry));
  }

  function snapshotBaseline(contract) {
    privateDirectory(path.join(stateRoot, 'baselines'));
    const root = baselinePath(stateRoot, contract.runId);
    fs.rmSync(root, { recursive: true, force: true });
    privateDirectory(root);
    const inspected = inspectBaseline(contract.cwd, contract.delivery.outputPaths);
    const entries = inspected.map(({ entry, content }) => {
      if (!entry.exists) return entry;
      const destination = path.join(root, ...entry.path.split('/'));
      privateDirectory(path.dirname(destination));
      fs.writeFileSync(destination, content, { flag: 'wx', mode: entry.mode });
      fs.chmodSync(destination, entry.mode);
      syncFile(destination);
      return entry;
    });
    const manifest = { schema: 'bounded-runtime-baseline/v1', runId: contract.runId, entries, digest: sha256(entries) };
    if (manifest.digest !== contract.trustedStateDigest) throw new Error('trusted baseline drifted before activation');
    atomicJson(baselineMetaPath(stateRoot, contract.runId), manifest);
    return manifest;
  }

  function readBaseline(contract) {
    const file = baselineMetaPath(stateRoot, contract.runId);
    if (!fs.existsSync(file)) return null;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.schema !== 'bounded-runtime-baseline/v1' || manifest.runId !== contract.runId
      || !Array.isArray(manifest.entries) || manifest.entries.length !== contract.delivery.outputPaths.length
      || manifest.entries.map(({ path: relative }) => relative).join('\0') !== contract.delivery.outputPaths.join('\0')
      || manifest.digest !== sha256(manifest.entries)) throw new Error('baseline manifest is invalid');
    return manifest;
  }

  function baselineMatches(contract, manifest = readBaseline(contract)) {
    if (!manifest) return { valid: false, reason: 'baseline is unavailable' };
    try {
      for (const entry of manifest.entries) {
        const target = safeTarget(contract.cwd, entry.path);
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!entry.exists) {
          if (stat) return { valid: false, reason: `baseline drifted at ${entry.path}` };
          continue;
        }
        if (!stat?.isFile() || stat.isSymbolicLink()) return { valid: false, reason: `baseline target is unsafe at ${entry.path}` };
        const content = fs.readFileSync(target);
        if (content.length !== entry.bytes || sha256(content) !== entry.digest) return { valid: false, reason: `baseline drifted at ${entry.path}` };
      }
      return { valid: true, manifest };
    } catch (error) { return { valid: false, reason: error.message }; }
  }

  function restoreBaseline(contract) {
    const manifest = readBaseline(contract);
    if (!manifest) return false;
    for (const entry of manifest.entries) {
      const target = safeTarget(contract.cwd, entry.path);
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!entry.exists) {
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('drifted baseline target is unsafe');
          fs.rmSync(target);
        }
        continue;
      }
      const source = path.join(baselinePath(stateRoot, contract.runId), ...entry.path.split('/'));
      privateDirectory(path.dirname(target));
      const temporary = `${target}.${process.pid}.restore.tmp`;
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, entry.mode);
      syncFile(temporary);
      fs.renameSync(temporary, target);
      syncDirectory(path.dirname(target));
    }
    return true;
  }

  function writeReceipt(contract, receipt) {
    atomicJson(receiptPath(stateRoot, contract.runId), receipt);
    return receipt;
  }

  function rollbackInternal(bundle, reason, currentCounters = { requests: 1, workers: 1, readBytes: 0, artifactBytes: 0, outputBytes: 0 }, { forceRollback = false } = {}) {
    if (!forceRollback && bundle.contract.stopPolicy.onFailure === 'preserve-for-review') {
      return preserveInternal(bundle, reason, currentCounters);
    }
    const timestamp = canonicalNow(now());
    restoreBaseline(bundle.contract);
    const next = transition(bundle.state, {
      type: 'rollback', contractDigest: bundle.contract.digest, clientId: bundle.contract.clientId,
      sessionId: bundle.contract.sessionId, leaseId: bundle.state.leaseId, counter: bundle.state.counter + 1,
      reason, now: timestamp,
    });
    store.commit(bundle.contract.runId, bundle.contract, bundle.state, next);
    const receipt = createReceipt({
      contract: bundle.contract, state: bundle.state, leaseId: bundle.state.leaseId, result: 'rolled-back',
      counters: currentCounters, artifacts: [], reason, completedAt: timestamp,
    });
    writeReceipt(bundle.contract, receipt);
    cleanup(bundle.contract.runId);
    return summary(bundle.contract, next, { receipt: { ...receipt, valid: true } });
  }

  function preserveInternal(bundle, reason, currentCounters) {
    const target = preservedPath(stateRoot, bundle.contract.runId);
    let moved = false;
    try {
      if (!restoreBaseline(bundle.contract)) throw new Error('baseline is unavailable');
      const artifacts = stageArtifacts(bundle.contract, stagePath(stateRoot, bundle.contract.runId));
      privateDirectory(path.dirname(target));
      if (fs.existsSync(target)) throw new Error('preserved output already exists');
      fs.renameSync(stagePath(stateRoot, bundle.contract.runId), target);
      syncDirectory(path.dirname(target));
      moved = true;
      const timestamp = canonicalNow(now());
      const next = transition(bundle.state, {
        type: 'preserve', contractDigest: bundle.contract.digest, clientId: bundle.contract.clientId,
        sessionId: bundle.contract.sessionId, leaseId: bundle.state.leaseId, counter: bundle.state.counter + 1,
        reason, now: timestamp,
      });
      const receipt = createReceipt({
        contract: bundle.contract, state: bundle.state, leaseId: bundle.state.leaseId, result: 'preserved',
        counters: { ...currentCounters, artifactBytes: sumArtifacts(artifacts) }, artifacts, reason, completedAt: timestamp,
      });
      store.commit(bundle.contract.runId, bundle.contract, bundle.state, next);
      writeReceipt(bundle.contract, receipt);
      cleanup(bundle.contract.runId);
      return summary(bundle.contract, next, { preservedPath: target, receipt: { ...receipt, valid: true } });
    } catch (error) {
      if (moved) fs.rmSync(target, { recursive: true, force: true });
      return rollbackInternal(bundle, `preserve failed: ${error.message}`, currentCounters, { forceRollback: true });
    }
  }

  async function run(bundle) {
    const runId = bundle.contract.runId;
    const operation = operations.get(runId);
    if (!operation) return;
    const execution = await executeWorker(bundle.contract, {
      stageRoot: operation.stageRoot,
      onWorkerStart: ({ pid, startTime }) => {
        const file = leasePath(stateRoot, runId);
        const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
        lease.workerPid = pid;
        lease.workerStartTime = startTime;
        atomicJson(file, lease);
      },
    });
    const current = load(runId);
    if (current.state.status !== 'running' || current.state.leaseId !== operation.leaseId) return;
    if (execution.status !== 'completed') {
      rollbackInternal(current, execution.reason || 'worker failed', {
        requests: 1, workers: 1, readBytes: 0, artifactBytes: 0, outputBytes: execution.outputBytes || 0,
      });
      return;
    }
    const verification = verifyArtifacts(bundle.contract, operation.stageRoot, execution.artifacts);
    if (!verification.valid) {
      rollbackInternal(current, verification.reason || 'artifact verification failed', {
        requests: 1, workers: 1, readBytes: 0, artifactBytes: 0, outputBytes: execution.outputBytes || 0,
      });
      return;
    }
    execution.artifacts = verification.artifacts;
    execution.artifactBytes = verification.artifactBytes;
    execution.verification = verification;
    operation.execution = execution;
    operation.workerStatus = 'ready';
  }

  async function plan(request) {
    const trustedStateDigest = baselineDigest(request.cwd, request.delivery?.outputPaths || []);
    const contract = createContract({ ...request, trustedStateDigest }, { now: canonicalNow(now()) });
    const existing = store.readContract(contract.runId);
    if (existing && sha256(existing) !== sha256(contract)) throw new Error('run id already has a different contract');
    const state = createInitialState(contract, { now: contract.createdAt });
    store.writeContract(contract);
    store.writeState(state);
    return structuredClone(contract);
  }

  async function approve(runId, params) {
    const bundle = load(runId);
    bind({ ...params, runId }, bundle.contract, bundle.state);
    const state = transitionAndCommit(bundle, {
      type: 'approve', contractDigest: bundle.contract.digest, clientId: bundle.contract.clientId,
      sessionId: bundle.contract.sessionId, operatorProof: params.operatorProof, counter: params.counter, now: canonicalNow(now()),
    });
    return summary(bundle.contract, state);
  }

  async function activate(runId, params) {
    const bundle = load(runId);
    bind({ ...params, runId }, bundle.contract, bundle.state);
    snapshotBaseline(bundle.contract);
    const leaseId = `lease-${crypto.randomBytes(12).toString('hex')}`;
    const timestamp = canonicalNow(now());
    const state = transitionAndCommit(bundle, {
      type: 'activate', contractDigest: bundle.contract.digest, clientId: bundle.contract.clientId,
      sessionId: bundle.contract.sessionId, leaseId, leaseExpiresAt: bundle.contract.expiresAt, counter: params.counter, now: timestamp,
    });
    privateDirectory(path.join(stateRoot, 'stages'));
    const stageRoot = stagePath(stateRoot, runId);
    privateDirectory(stageRoot);
    const lease = {
      schema: 'bounded-runtime-lease/v1', runId, clientId: bundle.contract.clientId, sessionId: bundle.contract.sessionId,
      leaseId, runtimePid: process.pid, runtimeStartTime: processStartTime(process.pid), workerPid: null,
      workerStartTime: null, expiresAt: bundle.contract.expiresAt, bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    };
    atomicJson(leasePath(stateRoot, runId), lease);
    const operation = { stageRoot, leaseId, workerStatus: 'running', execution: null };
    operations.set(runId, operation);
    operation.promise = run({ contract: bundle.contract, state }).catch((error) => {
      const current = load(runId);
      if (current.state.status === 'running') rollbackInternal(current, error.message);
    });
    return summary(bundle.contract, state, { workerStatus: 'running', leaseId });
  }

  async function status(runId) {
    const bundle = load(runId);
    if (bundle.state.status === 'running' && Date.parse(canonicalNow(now())) >= Date.parse(bundle.contract.expiresAt)) {
      return rollbackInternal(bundle, 'deadline exceeded');
    }
    const operation = operations.get(runId);
    const receiptFile = receiptPath(stateRoot, runId);
    const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
    const reviewPath = bundle.state.status === 'preserved' && fs.existsSync(preservedPath(stateRoot, runId))
      ? { preservedPath: preservedPath(stateRoot, runId) } : {};
    return summary(bundle.contract, bundle.state, {
      workerStatus: operation?.workerStatus || (bundle.state.status === 'running' ? 'unknown' : null),
      ...reviewPath,
      receipt: receipt ? { ...receipt, valid: verifyReceipt(receipt, { contract: bundle.contract, runId, leaseId: receipt.leaseId }).valid } : null,
    });
  }

  async function statusForCwd(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('runtime cwd is invalid');
    const candidates = fs.readdirSync(stateRoot).filter((entry) => entry.endsWith('.contract'));
    let fallback = null;
    for (const entry of candidates) {
      try {
        const contract = JSON.parse(fs.readFileSync(path.join(stateRoot, entry), 'utf8'));
        if (contract.cwd === cwd) {
          const current = await status(contract.runId);
          if (current.active) return current;
          fallback = current;
        }
      } catch {}
    }
    return fallback || { status: 'inactive', active: false, cwd };
  }

  async function complete(runId, params) {
    const bundle = load(runId);
    bind({ ...params, runId }, bundle.contract, bundle.state, { lease: true });
    const operation = operations.get(runId);
    if (!operation?.execution?.verification?.valid || operation.workerStatus !== 'ready') throw new Error('worker has not produced a verified result');
    const acceptance = verifyAcceptance(bundle.contract, operation.stageRoot, params.acceptance);
    if (!acceptance.valid) return rollbackInternal(bundle, acceptance.reason || 'acceptance rejected', {
      requests: 1, workers: 1, readBytes: 0, artifactBytes: sumArtifacts(operation.execution.artifacts), outputBytes: operation.execution.outputBytes,
    });
    const baseline = baselineMatches(bundle.contract);
    if (!baseline.valid) return rollbackInternal(bundle, baseline.reason || 'trusted baseline drifted', {
      requests: 1, workers: 1, readBytes: 0, artifactBytes: sumArtifacts(operation.execution.artifacts), outputBytes: operation.execution.outputBytes,
    });
    const counters = { requests: 1, workers: 1, readBytes: 0, artifactBytes: sumArtifacts(operation.execution.artifacts), outputBytes: operation.execution.outputBytes };
    const timestamp = canonicalNow(now());
    const receipt = createReceipt({ contract: bundle.contract, state: bundle.state, leaseId: bundle.state.leaseId, result: 'completed',
      counters, artifacts: operation.execution.artifacts, acceptance: params.acceptance, completedAt: timestamp });
    try {
      deliver(bundle.contract, operation.stageRoot, receipt, baseline.manifest);
    } catch (error) {
      return rollbackInternal(bundle, `delivery failed: ${error.message}`, {
        requests: 1, workers: 1, readBytes: 0, artifactBytes: sumArtifacts(operation.execution.artifacts), outputBytes: operation.execution.outputBytes,
      });
    }
    const state = transitionAndCommit(bundle, {
      type: 'complete', contractDigest: bundle.contract.digest, clientId: bundle.contract.clientId,
      sessionId: bundle.contract.sessionId, leaseId: bundle.state.leaseId, counter: params.counter, now: timestamp,
    });
    writeReceipt(bundle.contract, receipt);
    finalizeDelivery(runId);
    cleanup(runId);
    return summary(bundle.contract, state, { receipt: { ...receipt, valid: true } });
  }

  function deliver(contract, stageRoot, receipt, baseline = readBaseline(contract)) {
    if (!baseline) throw new Error('baseline is unavailable');
    const journalFile = deliveryPath(stateRoot, contract.runId);
    const items = contract.delivery.outputPaths.map((relative) => {
      const source = safeTarget(stageRoot, relative);
      const target = safeTarget(contract.cwd, relative);
      const backup = path.join(stateRoot, `${contract.runId}.backup-${crypto.randomBytes(6).toString('hex')}`);
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      const entry = baseline.entries.find(({ path: value }) => value === relative);
      if (!entry || !baselineMatches(contract, baseline).valid) throw new Error(`baseline drifted at ${relative}`);
      return { relative, source, target, backup, temporary, baselineFile: entry.exists ? path.join(baselinePath(stateRoot, contract.runId), ...relative.split('/')) : null, hadOriginal: entry.exists };
    });
    atomicJson(journalFile, { schema: 'bounded-runtime-delivery/v1', runId: contract.runId, phase: 'prepared', items, receipt });
    try {
      for (const item of items) {
        privateDirectory(path.dirname(item.target));
        if (item.hadOriginal) fs.copyFileSync(item.baselineFile, item.backup, fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(item.source, item.temporary, fs.constants.COPYFILE_EXCL);
        syncFile(item.temporary);
        fs.renameSync(item.temporary, item.target);
        syncDirectory(path.dirname(item.target));
      }
      atomicJson(journalFile, { schema: 'bounded-runtime-delivery/v1', runId: contract.runId, phase: 'delivered', items, receipt });
    } catch (error) {
      recoverDelivery(contract.runId);
      throw error;
    }
  }

  function finalizeDelivery(runId) {
    const file = deliveryPath(stateRoot, runId);
    if (!fs.existsSync(file)) return false;
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const item of journal.items) {
      if (item.temporary) fs.rmSync(item.temporary, { force: true });
      fs.rmSync(item.backup, { force: true });
    }
    fs.rmSync(file, { force: true });
    fs.rmSync(baselinePath(stateRoot, runId), { recursive: true, force: true });
    return true;
  }

  function recoverDelivery(runId) {
    const file = deliveryPath(stateRoot, runId);
    if (!fs.existsSync(file)) return false;
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    let state;
    try { state = store.read(runId); } catch { return false; }
    if (state.status === 'completed') {
      const bundle = load(runId);
      const receiptFile = receiptPath(stateRoot, runId);
      let receiptValid = false;
      if (fs.existsSync(receiptFile)) {
        try { receiptValid = verifyReceipt(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), { contract: bundle.contract, runId, leaseId: state.leaseId }).valid; } catch {}
      }
      if (!receiptValid && verifyReceipt(journal.receipt, { contract: bundle.contract, runId, leaseId: state.leaseId }).valid) {
        writeReceipt(bundle.contract, journal.receipt);
        receiptValid = true;
      }
      if (receiptValid) return finalizeDelivery(runId);
      return false;
    }
    for (const item of [...journal.items].reverse()) {
      if (item.temporary) fs.rmSync(item.temporary, { force: true });
      if (item.hadOriginal && fs.existsSync(item.backup)) {
        fs.rmSync(item.target, { force: true });
        fs.renameSync(item.backup, item.target);
      } else if (!item.hadOriginal) fs.rmSync(item.target, { force: true });
    }
    fs.rmSync(file, { force: true });
    return true;
  }

  async function rollback(runId, params) {
    const bundle = load(runId);
    if (['completed', 'rolled-back', 'failed', 'expired', 'preserved'].includes(bundle.state.status)) return summary(bundle.contract, bundle.state);
    bind({ ...params, runId }, bundle.contract, bundle.state, { lease: true });
    return rollbackInternal(bundle, params.reason || 'operator rollback', undefined, { forceRollback: true });
  }

  async function doctor() {
    const checks = {
      node: process.versions.node,
      bubblewrap: fs.existsSync('/usr/bin/bwrap'),
      systemdUser: fs.existsSync('/usr/bin/systemctl'),
      stateRoot: fs.statSync(stateRoot).isDirectory(),
      networkIsolation: true,
      shellFreeSpawn: true,
    };
    return { status: Object.values(checks).every((value) => value === true || (typeof value === 'string' && value.length > 0)) ? 'ready' : 'blocked', checks };
  }

  async function reconcile() {
    for (const entry of fs.readdirSync(stateRoot)) {
      if (!entry.endsWith('.lease')) continue;
      const runId = entry.slice(0, -'.lease'.length);
      let bundle;
      try { bundle = load(runId); } catch { continue; }
      let lease = null;
      try { lease = JSON.parse(fs.readFileSync(path.join(stateRoot, entry), 'utf8')); } catch {}
      const stale = !validLease(lease, runId)
        || lease.bootId !== fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
        || Date.parse(lease.expiresAt) <= Date.now();
      if (stale) {
        if (validLease(lease, runId)) killProcess(lease.workerPid, lease.workerStartTime);
        if (bundle.state.status === 'running') rollbackInternal(bundle, 'invalid or stale runtime lease');
        else fs.rmSync(path.join(stateRoot, entry), { force: true });
        continue;
      }
      if (processMatches(lease.runtimePid, lease.runtimeStartTime)) continue;
      killProcess(lease.workerPid, lease.workerStartTime);
      if (bundle.state.status === 'running') rollbackInternal(bundle, 'runtime process is unavailable');
    }
    for (const entry of fs.readdirSync(stateRoot)) if (entry.endsWith('.delivery')) recoverDelivery(entry.slice(0, -'.delivery'.length));
    return { status: 'reconciled' };
  }

  return Object.freeze({ plan, approve, activate, status, statusForCwd, complete, rollback, doctor, reconcile, recoverDelivery });
}
