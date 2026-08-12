import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clearCancellation, clearRecovery, readCancellation, readRecovery, readState, restoreStateBytes,
  withStateLock, writeCancellation,
} from '../core/state.mjs';
import { cleanupScratch } from '../core/scratch.mjs';

const TIMER = 'omp-bounded-guard.timer';
const LEASE_SCHEMA = 'omp-bounded-guard-lease/v1';
const RUN_ID = /^run_[a-f0-9]{24}$/;
const DEFAULT_DOCTOR_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/doctor.mjs');

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filePath);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function command(run, command, args) {
  const result = run(command, args);
  if (!result || result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function readLease(leasePath) {
  if (!fs.existsSync(leasePath)) return null;
  const stat = fs.lstatSync(leasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('bounded guard lease is unsafe');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('bounded guard lease is not host-owned');
  }
  const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  if (lease?.schema !== LEASE_SCHEMA
    || Object.keys(lease).sort().join(',') !== 'bootId,deadlineUnit,expiresAt,pid,pidStartTime,runId,schema,workerPid,workerStartTime'
    || !RUN_ID.test(lease.runId || '')
    || !Number.isInteger(lease.pid) || lease.pid < 1
    || !/^\d+$/.test(lease.pidStartTime || '')
    || !/^omp-bounded-deadline-[a-f0-9]{24}$/.test(lease.deadlineUnit || '')
    || (lease.workerPid !== null && (!Number.isInteger(lease.workerPid) || lease.workerPid < 1))
    || (lease.workerStartTime !== null && !/^\d+$/.test(lease.workerStartTime || ''))
    || (lease.workerPid === null) !== (lease.workerStartTime === null)
    || typeof lease.bootId !== 'string' || !lease.bootId
    || !Number.isFinite(Date.parse(lease.expiresAt || ''))
    || new Date(lease.expiresAt).toISOString() !== lease.expiresAt) {
    throw new Error('bounded guard lease is invalid');
  }
  return lease;
}

function deadlineEvidenceMatches(statePath, runId) {
  try {
    const evidence = JSON.parse(fs.readFileSync(`${statePath}.deadline-evidence`, 'utf8'));
    return evidence?.schema === 'omp-bounded-deadline-evidence/v1'
      && evidence.source === 'deadline' && evidence.runId === runId
      && Object.keys(evidence).sort().join(',') === 'runId,schema,source,triggerAt'
      && Number.isFinite(Date.parse(evidence.triggerAt))
      && new Date(evidence.triggerAt).toISOString() === evidence.triggerAt;
  } catch { return false; }
}

function deadlinePendingMatches(statePath, runId) {
  try {
    const pending = JSON.parse(fs.readFileSync(`${statePath}.deadline-pending`, 'utf8'));
    return pending?.schema === 'omp-bounded-deadline-pending/v1' && pending.runId === runId;
  } catch { return false; }
}

function processStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  } catch { return null; }
}

function systemdCalendar(iso) {
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function quarantine(filePath) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return null;
  const prefix = `${filePath}.unsafe-${Date.now()}-${process.pid}`;
  let target = prefix;
  for (let sequence = 1; fs.lstatSync(target, { throwIfNoEntry: false }); sequence += 1) target = `${prefix}-${sequence}`;
  fs.renameSync(filePath, target);
  return target;
}

function removeLease(leasePath) {
  const stat = fs.lstatSync(leasePath, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) quarantine(leasePath);
  else fs.rmSync(leasePath);
}

function emergencyProtect(statePath) {
  let qualification = {};
  let routing = {};
  const stat = fs.lstatSync(statePath, { throwIfNoEntry: false });
  if (stat?.isFile() && !stat.isSymbolicLink()) {
    try {
      const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (current?.qualification && typeof current.qualification === 'object' && !Array.isArray(current.qualification)) {
        qualification = current.qualification;
      }
      if (current?.routing && typeof current.routing === 'object' && !Array.isArray(current.routing)) routing = current.routing;
    } catch {}
  }
  if (stat && (!stat.isFile() || stat.isSymbolicLink()
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) quarantine(statePath);
  atomicJson(statePath, {
    schema: 'omp-host-trusted-state/v1',
    level: 'L3-narrow-write',
    killSwitch: { active: true, marker: 'UNATTENDED_MODE_DISABLED' },
    qualification,
    routing,
  });
}

function currentBootId() {
  return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function monotonicNow() {
  return Number(process.hrtime.bigint() / 1_000n);
}

function sharedMonotonicNow(nodePath, run) {
  const local = monotonicNow();
  if (!process.versions?.bun) return local;
  try {
    const output = command(run, nodePath, ['-e', 'process.stdout.write(String(Number(process.hrtime.bigint() / 1000n)))']);
    const value = Number(output);
    if (Number.isSafeInteger(value) && value > 0) return value;
  } catch {}
  return local;
}

const HEARTBEAT_SCHEMA = 'omp-bounded-guard-heartbeat/v1';

function readHeartbeat(heartbeatPath) {
  try {
    const stat = fs.lstatSync(heartbeatPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
    const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
    return heartbeat?.schema === HEARTBEAT_SCHEMA
      && Object.keys(heartbeat).sort().join(',') === 'monotonicUs,schema'
      && Number.isSafeInteger(heartbeat.monotonicUs) && heartbeat.monotonicUs > 0
      ? heartbeat : null;
  } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function leaseProcessAlive(lease) {
  return processAlive(lease.pid) && processStartTime(lease.pid) === lease.pidStartTime;
}

function leaseStillCurrent(statePath, leasePath, expected) {
  try {
    const recovery = readRecovery(statePath);
    const lease = readLease(leasePath);
    return recovery?.pending?.runId === expected.runId
      && lease?.runId === expected.runId
      && lease.pid === expected.pid
      && lease.pidStartTime === expected.pidStartTime;
  } catch { return false; }
}

async function terminateLeaseProcess(lease, statePath, leasePath) {
  if (lease.workerPid && processStartTime(lease.workerPid) === lease.workerStartTime) {
    try { process.kill(-lease.workerPid, 'SIGKILL'); } catch { try { process.kill(lease.workerPid, 'SIGKILL'); } catch {} }
  }
  if (!leaseStillCurrent(statePath, leasePath, lease)) return false;
  if (lease.pid === process.pid || !leaseProcessAlive(lease)) return false;
  writeCancellation(statePath, lease.runId);
  for (let attempt = 0; attempt < 20 && leaseStillCurrent(statePath, leasePath, lease); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !leaseStillCurrent(statePath, leasePath, lease);
}

function protectedState(statePath) {
  try {
    const state = readState(statePath);
    return state.level === 'L3-narrow-write'
      && state.killSwitch.active === true
      && state.killSwitch.marker === 'UNATTENDED_MODE_DISABLED';
  } catch { return false; }
}

export function renderGuardService({ nodePath, doctorPath, manifestPath, stateRoot }) {
  for (const [name, value] of Object.entries({ nodePath, doctorPath, manifestPath, stateRoot })) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[%\n\r"\\]/.test(value)) {
      throw new Error(`${name} must be a safe absolute path`);
    }
  }
  return fs.readFileSync(new URL('../systemd/omp-bounded-guard.service.in', import.meta.url), 'utf8')
    .replaceAll('@NODE_PATH@', nodePath)
    .replaceAll('@DOCTOR_PATH@', doctorPath)
    .replaceAll('@MANIFEST_PATH@', manifestPath)
    .replaceAll('@STATE_ROOT@', stateRoot);
}

export function createSystemdGuard({
  statePath, stateRoot, deliveryRoot, systemctlPath, systemdRunPath, nodePath, flockPath, run,
  doctorPath = DEFAULT_DOCTOR_PATH, manifestPath = path.join(stateRoot, 'installation.json'), clock,
}) {
  if (typeof run !== 'function') throw new Error('systemd command runner is required');
  const stateRelative = path.relative(stateRoot, statePath);
  if (!path.isAbsolute(statePath) || !path.isAbsolute(stateRoot) || path.dirname(statePath) !== stateRoot || !stateRelative
    || stateRelative.startsWith('..') || path.isAbsolute(stateRelative)) throw new Error('guard state path is unsafe');
  const leasePath = `${statePath}.guard`;
  const now = clock ?? (() => sharedMonotonicNow(nodePath, run));

  function clearDeadline(lease, { skipService = false, skipTimer = false } = {}) {
    if (!lease?.deadlineUnit) return;
    const units = skipTimer ? [] : [`${lease.deadlineUnit}.timer`];
    if (!skipService) units.push(`${lease.deadlineUnit}.service`);
    if (!units.length) return;
    for (const args of [
      ['--user', 'stop', ...units],
      ['--user', 'reset-failed', ...units],
    ]) run(systemctlPath, args);
  }

  async function rollbackUnlocked(reason = 'guard', { skipDeadlineCleanup = false } = {}) {
    if (typeof reason !== 'string' || !reason) throw new Error('rollback reason is required');
    let recovery;
    let lease;
    try { lease = readLease(leasePath); } catch {}
    const clearCancel = () => {
      try { clearCancellation(statePath); }
      catch { quarantine(`${statePath}.cancel`); }
    };
    try { recovery = readRecovery(statePath); }
    catch (error) {
      emergencyProtect(statePath);
      quarantine(`${statePath}.recovery`);
      clearDeadline(lease, { skipService: skipDeadlineCleanup, skipTimer: skipDeadlineCleanup });
      removeLease(leasePath);
      clearCancel();
      return { status: 'protected', reason: 'malformed-recovery' };
    }
    lease ??= recovery ? { deadlineUnit: `omp-bounded-deadline-${recovery.pending.runId.slice(4)}` } : null;
    if (recovery) {
      if (recovery.pending.reason === 'delivery') {
        if (!protectedState(statePath)) restoreStateBytes(statePath, recovery.pending.baseline);
        clearDeadline(lease, { skipService: skipDeadlineCleanup, skipTimer: skipDeadlineCleanup });
        removeLease(leasePath);
        clearCancel();
        return { status: 'controller-required', reason: 'delivery' };
      }
      restoreStateBytes(statePath, recovery.pending.baseline);
      if (reason !== 'completed' && recovery.scratch) cleanupScratch(recovery.scratch, recovery.pending.runId, deliveryRoot);
      clearRecovery(statePath);
    }
    clearDeadline(lease, { skipService: skipDeadlineCleanup, skipTimer: skipDeadlineCleanup });
    removeLease(leasePath);
    clearCancel();
    fs.rmSync(`${statePath}.deadline-pending`, { force: true });
    if (!recovery && !protectedState(statePath)) emergencyProtect(statePath);
    if (!protectedState(statePath)) throw new Error('rollback verification failed');
    return { status: 'protected', reason };
  }

  async function rollback(reason = 'guard', { lockHeld = false } = {}) {
    if (lockHeld) return rollbackUnlocked(reason);
    return withStateLock(statePath, flockPath, nodePath, () => rollbackUnlocked(reason));
  }

  return Object.freeze({
    async status() {
      let timerActive = false;
      try { timerActive = command(run, systemctlPath, ['--user', 'is-active', TIMER]) === 'active'; } catch {}
      let timerEnabled = false;
      try {
        const enablement = command(run, systemctlPath, ['--user', 'is-enabled', TIMER]);
        timerEnabled = /^(?:enabled|enabled-runtime)$/.test(enablement) ? enablement : false;
      } catch {}
      let serviceResult = null;
      let execMainStatus = null;
      let lastReconciled = null;
      try {
        const shown = command(run, systemctlPath, [
          '--user', 'show', 'omp-bounded-guard.service',
          '--property=Result', '--property=ExecMainStatus', '--property=ExecMainExitTimestampMonotonic',
        ]);
        const properties = Object.fromEntries(shown.split('\n').filter(Boolean).map((line) => {
          const separator = line.indexOf('=');
          return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
        }));
        serviceResult = properties.Result || null;
        execMainStatus = /^\d+$/.test(properties.ExecMainStatus || '') ? Number(properties.ExecMainStatus) : null;
        lastReconciled = /^\d+$/.test(properties.ExecMainExitTimestampMonotonic || '')
          && Number(properties.ExecMainExitTimestampMonotonic) > 0
          ? Number(properties.ExecMainExitTimestampMonotonic) : null;
      } catch {}
      let recovery;
      let lease;
      let drift = false;
      try { recovery = readRecovery(statePath); } catch { drift = true; }
      try { lease = readLease(leasePath); } catch { drift = true; }
      if (Boolean(recovery) !== Boolean(lease)
        || (recovery && lease && recovery.pending.runId !== lease.runId)) drift = true;
      const state = (() => { try { return readState(statePath); } catch { return null; } })();
      const routing = state?.routing;
      const chains = routing?.chains;
      const currentMonotonic = now();
      const heartbeat = readHeartbeat(`${statePath}.guard-heartbeat`);
      if (heartbeat) lastReconciled = heartbeat.monotonicUs;
      return {
        timerActive,
        timerEnabled,
        serviceResult,
        execMainStatus,
        lastReconciled,
        monotonicNow: currentMonotonic,
        lastReconciledUs: lastReconciled,
        monotonicNowUs: currentMonotonic,
        reconciliationAgeUs: lastReconciled !== null && currentMonotonic >= lastReconciled ? currentMonotonic - lastReconciled : null,
        maxAgeUs: 120_000_000,
        killSwitchActive: protectedState(statePath),
        routingReady: typeof routing?.reviewerFamily === 'string' && Array.isArray(chains) && chains.length >= 2,
        providersReady: Array.isArray(chains) && chains.every((chain) => Array.isArray(chain.selectors) && chain.selectors.length > 0),
        digestsReady: state?.qualification?.status === 'ready',
        drift,
      };
    },

    async activate(contract) {
      if (!RUN_ID.test(contract?.runId || '')
        || !Number.isFinite(Date.parse(contract?.expiresAt || ''))
        || new Date(contract.expiresAt).toISOString() !== contract.expiresAt) {
        throw new Error('guard activation contract is invalid');
      }
      if (command(run, systemctlPath, ['--user', 'is-active', TIMER]) !== 'active') {
        throw new Error('bounded guard timer is inactive');
      }
      const recovery = readRecovery(statePath);
      if (recovery?.pending?.runId !== contract.runId || recovery.active !== null) {
        throw new Error('guard activation is not bound to pending recovery');
      }
      fs.rmSync(`${statePath}.deadline-evidence`, { force: true });
      fs.rmSync(`${statePath}.deadline-pending`, { force: true });
      atomicJson(leasePath, {
        schema: LEASE_SCHEMA,
        runId: contract.runId,
        pid: process.pid,
        pidStartTime: processStartTime(process.pid),
        deadlineUnit: `omp-bounded-deadline-${contract.runId.slice(4)}`,
        workerPid: null,
        workerStartTime: null,
        bootId: currentBootId(),
        expiresAt: contract.expiresAt,
      });
      const lease = readLease(leasePath);
      command(run, systemdRunPath, [
        '--user', `--unit=${lease.deadlineUnit}`, `--on-calendar=${systemdCalendar(lease.expiresAt)}`,
        '--timer-property=AccuracySec=1s', '--timer-property=Persistent=true',
        '--timer-property=RemainAfterElapse=false',
        '--property=UMask=0077', '--property=NoNewPrivileges=true', '--property=PrivateTmp=true',
        '--property=ProtectSystem=strict', '--property=ProtectHome=read-only',
        '--collect',
        `--property=ReadWritePaths=${stateRoot}`,
        nodePath, doctorPath, 'deadline', '--manifest', manifestPath, '--run-id', lease.runId,
      ]);
      if (command(run, systemctlPath, ['--user', 'is-active', `${lease.deadlineUnit}.timer`]) !== 'active') {
        throw new Error('bounded deadline timer is inactive');
      }
      const properties = command(run, systemctlPath, [
        '--user', 'show', `${lease.deadlineUnit}.timer`, '--property=AccuracyUSec', '--property=Persistent',
      ]);
      if (!/^AccuracyUSec=(?:1s|1000000)$/m.test(properties) || !/^Persistent=yes$/m.test(properties)) {
        throw new Error('bounded deadline timer properties are invalid');
      }
    },

    bindProcess(runId, pid) {
      const lease = readLease(leasePath);
      if (lease?.runId !== runId || !Number.isInteger(pid) || pid < 1) throw new Error('guard worker binding is invalid');
      const startTime = processStartTime(pid);
      if (!startTime) throw new Error('guard worker process is unavailable');
      atomicJson(leasePath, { ...lease, workerPid: pid, workerStartTime: startTime });
    },

    rollback,

    async deadline(runId) {
      if (!RUN_ID.test(runId || '')) throw new Error('deadline runId is invalid');
      const lease = readLease(leasePath);
      const recovery = readRecovery(statePath);
      if (!lease || lease.runId !== runId || recovery?.pending?.runId !== runId
        || recovery.active?.runId !== runId) {
        throw new Error('deadline run is not the exact active lease');
      }
      const triggerAt = new Date().toISOString();
      atomicJson(`${statePath}.deadline-evidence`, {
        schema: 'omp-bounded-deadline-evidence/v1', source: 'deadline', runId, triggerAt,
      });
      fs.rmSync(`${statePath}.deadline-pending`, { force: true });
      return this.reconcile({ deadlineRunId: runId });
    },

    async verifyRollback() {
      return protectedState(statePath) && !fs.existsSync(leasePath) && !fs.existsSync(`${statePath}.cancel`);
    },

    recordHeartbeat() {
      atomicJson(`${statePath}.guard-heartbeat`, { schema: HEARTBEAT_SCHEMA, monotonicUs: now() });
    },

    async reconcile({ now = new Date().toISOString(), bootId = currentBootId(), deadlineRunId = null } = {}) {
      // Expiry is the only pre-lock action: terminate the exact leased process, then acquire the shared directory flock.
      try {
        const previewRecovery = readRecovery(statePath);
        const previewLease = readLease(leasePath);
        if (previewRecovery?.pending?.reason === 'activation' && previewLease
          && previewLease.runId === previewRecovery.pending.runId && previewLease.bootId === bootId) {
          if (Date.parse(previewLease.expiresAt) > Date.parse(now) && leaseProcessAlive(previewLease)) {
            return { status: 'active', runId: previewLease.runId, expiresAt: previewLease.expiresAt };
          }
          if (Date.parse(previewLease.expiresAt) <= Date.parse(now)) {
            await terminateLeaseProcess(previewLease, statePath, leasePath);
          }
        }
      } catch {}
      return withStateLock(statePath, flockPath, nodePath, async () => {
        let recovery;
        try { recovery = readRecovery(statePath); }
        catch { return rollbackUnlocked('malformed-recovery', { skipDeadlineCleanup: Boolean(deadlineRunId) }); }
        if (!recovery) {
          if (fs.lstatSync(`${statePath}.recovery`, { throwIfNoEntry: false })) {
            emergencyProtect(statePath);
            quarantine(`${statePath}.recovery`);
          }
          let malformedLease = false;
          try { readLease(leasePath); } catch { malformedLease = true; }
          if (malformedLease) quarantine(leasePath);
          else removeLease(leasePath);
          try { clearCancellation(statePath); } catch { quarantine(`${statePath}.cancel`); }
          if (!protectedState(statePath)) emergencyProtect(statePath);
          return { status: 'protected', reason: malformedLease ? 'malformed-lease' : 'idle' };
        }
        if (recovery.pending.reason === 'delivery') return rollbackUnlocked('delivery');
        let lease;
        try { lease = readLease(leasePath); }
        catch {
          quarantine(leasePath);
          return rollbackUnlocked('malformed-lease', { skipDeadlineCleanup: Boolean(deadlineRunId) });
        }
        const reason = !lease || lease.runId !== recovery.pending.runId ? 'crash'
          : lease.bootId !== bootId ? 'reboot'
            : Date.parse(lease.expiresAt) <= Date.parse(now) ? 'expired'
              : !leaseProcessAlive(lease) ? 'crash' : null;
        if (reason === 'expired' && lease) {
          if (!deadlineRunId && !deadlineEvidenceMatches(statePath, lease.runId)) {
            if (!deadlinePendingMatches(statePath, lease.runId)) {
              atomicJson(`${statePath}.deadline-pending`, {
                schema: 'omp-bounded-deadline-pending/v1', runId: lease.runId,
              });
              return { status: 'active', runId: lease.runId, expiresAt: lease.expiresAt };
            }
          }
          if (readCancellation(statePath)?.runId !== lease.runId) writeCancellation(statePath, lease.runId);
        }
        return reason
          ? rollbackUnlocked(reason, { skipDeadlineCleanup: deadlineRunId === lease?.runId })
          : { status: 'active', runId: lease.runId, expiresAt: lease.expiresAt };
      });
    },
  });
}
