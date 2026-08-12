import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { sha256, stableSerialize } from './receipt.mjs';
import { validateScratch } from './scratch.mjs';

function safeRecoveryRelative(value) {
  return typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value && value.split('/').every((part) => part !== '..' && part !== '.');
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function syncFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function validScratch(value, runId) {
  try { validateScratch(value, runId); return true; } catch { return false; }
}

function assertAbsolute(name, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  const parent = fs.realpathSync(path.dirname(value));
  if (fs.existsSync(value)) {
    const stat = fs.lstatSync(value);
    if (stat.isSymbolicLink()) throw new Error(`${name} must not be a symlink`);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error(`${name} must be a host-owned private file with safe permissions`);
    }
  }
  if (path.dirname(value) !== parent) throw new Error(`${name} parent must not be aliased`);
}

export function validateStatePath(statePath) {
  assertAbsolute('statePath', statePath);
}

export function readState(statePath) {
  validateStatePath(statePath);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state?.schema !== 'omp-host-trusted-state/v1'
    || Object.keys(state).sort().join(',') !== 'killSwitch,level,qualification,routing,schema'
    || state.level !== 'L3-narrow-write'
    || !state.killSwitch || Object.keys(state.killSwitch).sort().join(',') !== 'active,marker') {
    throw new Error('bounded state schema is invalid');
  }
  return state;
}

export function readRecovery(statePath) {
  const filePath = `${statePath}.recovery`;
  if (!fs.existsSync(filePath)) return null;
  assertAbsolute('recoveryPath', filePath);
  if ((fs.lstatSync(filePath).mode & 0o077) !== 0) throw new Error('bounded recovery record is unsafe');
  const recovery = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (recovery?.schema !== 'omp-bounded-recovery/v1'
    || !recovery.pending || typeof recovery.pending.baseline !== 'string'
    || !['activation', 'delivery'].includes(recovery.pending.reason)
    || !/^run_[a-f0-9]{24}$/.test(recovery.pending.runId || '')
    || !Object.keys(recovery).every((key) => ['schema', 'pending', 'active', 'delivery', 'scratch'].includes(key))
    || !Object.keys(recovery.pending).every((key) => ['runId', 'baseline', 'reason'].includes(key))
    || (recovery.active !== null && (
      !recovery.active || Object.keys(recovery.active).sort().join(',') !== 'activatedAt,contractDigest,expiresAt,runId,scopeDigest,taskDigest'
      || recovery.active.runId !== recovery.pending.runId
      || !Number.isFinite(Date.parse(recovery.active.activatedAt))
      || new Date(recovery.active.activatedAt).toISOString() !== recovery.active.activatedAt
      || !Number.isFinite(Date.parse(recovery.active.expiresAt))
      || new Date(recovery.active.expiresAt).toISOString() !== recovery.active.expiresAt
      || Date.parse(recovery.active.activatedAt) >= Date.parse(recovery.active.expiresAt)
      || !/^sha256:[a-f0-9]{64}$/.test(recovery.active.contractDigest || '')
      || !/^sha256:[a-f0-9]{64}$/.test(recovery.active.taskDigest || '')
      || !/^sha256:[a-f0-9]{64}$/.test(recovery.active.scopeDigest || '')
    ))
    || (recovery.pending.reason === 'activation' && Object.hasOwn(recovery, 'delivery'))
    || (recovery.scratch !== undefined && !validScratch(recovery.scratch, recovery.pending.runId))
    || (recovery.pending.reason === 'delivery' && (
      recovery.active !== null || !recovery.delivery
      || Object.keys(recovery.delivery).sort().join(',') !== 'directories,items,phase,root,transaction'
      || typeof recovery.delivery.root !== 'string' || !path.isAbsolute(recovery.delivery.root)
      || !/^\.omp-run-[A-Za-z0-9_-]+$/.test(recovery.delivery.transaction || '')
      || !['preparing', 'prepared', 'committed-cleanup'].includes(recovery.delivery.phase)
      || !Array.isArray(recovery.delivery.directories)
      || recovery.delivery.directories.some((directory) => !safeRecoveryRelative(directory))
      || !Array.isArray(recovery.delivery.items) || recovery.delivery.items.length === 0
      || recovery.delivery.items.some((item) => !item
        || Object.keys(item).sort().join(',') !== 'backup,hadOriginal,installed,installing,relative'
        || !safeRecoveryRelative(item.relative) || typeof item.backup !== 'string'
        || typeof item.hadOriginal !== 'boolean' || typeof item.installing !== 'boolean'
        || typeof item.installed !== 'boolean')
    ))) {
    throw new Error('bounded recovery record is invalid');
  }
  return recovery;
}

export function writeRecovery(statePath, recovery) {
  const filePath = `${statePath}.recovery`;
  if (fs.existsSync(filePath)) assertAbsolute('recoveryPath', filePath);
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(recovery, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    syncFile(temporary);
    fs.renameSync(temporary, filePath);
    syncDirectory(path.dirname(filePath));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function clearRecovery(statePath) {
  const filePath = `${statePath}.recovery`;
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
    syncDirectory(path.dirname(filePath));
  }
}

export function readCancellation(statePath) {
  const filePath = `${statePath}.cancel`;
  if (!fs.existsSync(filePath)) return null;
  assertAbsolute('cancellationPath', filePath);
  if ((fs.lstatSync(filePath).mode & 0o077) !== 0) throw new Error('bounded cancellation record is unsafe');
  const cancellation = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (cancellation?.schema !== 'omp-bounded-cancellation/v1'
    || Object.keys(cancellation).sort().join(',') !== 'runId,schema'
    || !/^run_[a-f0-9]{24}$/.test(cancellation.runId || '')) {
    throw new Error('bounded cancellation record is invalid');
  }
  return cancellation;
}

export function writeCancellation(statePath, runId) {
  if (!/^run_[a-f0-9]{24}$/.test(runId || '')) throw new Error('bounded cancellation runId is invalid');
  const filePath = `${statePath}.cancel`;
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ schema: 'omp-bounded-cancellation/v1', runId })}\n`, {
      flag: 'wx', mode: 0o600,
    });
    syncFile(temporary);
    fs.renameSync(temporary, filePath);
    syncDirectory(path.dirname(filePath));
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function clearCancellation(statePath, runId) {
  const filePath = `${statePath}.cancel`;
  if (!fs.existsSync(filePath)) return;
  if (runId && readCancellation(statePath)?.runId !== runId) return;
  fs.rmSync(filePath);
  syncDirectory(path.dirname(filePath));
}

export function stateDigest(state) {
  return sha256(stableSerialize(state));
}

export function readStateBytes(statePath) {
  validateStatePath(statePath);
  return fs.readFileSync(statePath, 'utf8');
}

export function restoreStateBytes(statePath, content) {
  const parsed = JSON.parse(content);
  if (parsed?.schema !== 'omp-host-trusted-state/v1'
    || parsed.level !== 'L3-narrow-write'
    || parsed.killSwitch?.active !== true
    || parsed.killSwitch.marker !== 'UNATTENDED_MODE_DISABLED') {
    throw new Error('pending recovery baseline is not protected L3 state');
  }
  const temporary = path.join(
    path.dirname(statePath),
    `.bounded-restore-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    syncFile(temporary);
    fs.renameSync(temporary, statePath);
    syncDirectory(path.dirname(statePath));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function withStateLock(statePath, flockPath, nodePath, operation) {
  validateStatePath(statePath);
  const lockPath = path.dirname(statePath);
  const existing = fs.lstatSync(lockPath);
  if (!existing.isDirectory() || existing.isSymbolicLink() || fs.realpathSync(lockPath) !== lockPath
    || (existing.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && existing.uid !== process.getuid())) {
    throw new Error('bounded state lock directory is unsafe');
  }
  const child = spawn(flockPath, [
    '-n', lockPath, nodePath, '-e',
    "process.stdout.write('LOCKED\\n');process.stdin.resume()",
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('LOCKED\n')) resolve();
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('bounded state lock is held')));
  });
  try {
    return await operation();
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }
}
