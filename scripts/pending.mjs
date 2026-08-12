import path from 'node:path';

import { containsCredentialMaterial, validateInstallationManifest } from '../extensions/installation.mjs';
import {
  removeCreatedDirectories, removeDurable, restoreSnapshot, snapshot, validSnapshot, writeAtomic,
} from './install-state.mjs';

export const PENDING_SCHEMA = 'omp-bounded-install-pending/v1';
const NAMES = ['manifest', 'service', 'timer', 'lock', 'package', 'bunLock', 'bunLockb', 'link'];
const TIMER = 'omp-bounded-guard.timer';
const SERVICE = 'omp-bounded-guard.service';

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function expectedPaths(manifest) {
  return {
    manifest: path.join(manifest.stateRoot, 'installation.json'),
    service: path.join(manifest.systemdUnitDir, SERVICE),
    timer: path.join(manifest.systemdUnitDir, TIMER),
    lock: path.join(manifest.pluginsRoot, 'omp-plugins.lock.json'),
    package: path.join(manifest.pluginsRoot, 'package.json'),
    bunLock: path.join(manifest.pluginsRoot, 'bun.lock'),
    bunLockb: path.join(manifest.pluginsRoot, 'bun.lockb'),
    link: path.join(manifest.pluginsRoot, 'node_modules', 'omp-bounded'),
  };
}

function decodedCredential(saved) {
  if (saved.kind !== 'file') return false;
  const text = Buffer.from(saved.bytes, 'base64').toString('utf8');
  try { return containsCredentialMaterial(JSON.parse(text)); }
  catch { return containsCredentialMaterial(text); }
}

function validatePending(value) {
  if (!exact(value, [
    'schema', 'operation', 'manifest', 'paths', 'files', 'receiptPath', 'receipt',
    'createdDirectories', 'unitState',
  ]) || value.schema !== PENDING_SCHEMA || !['install', 'uninstall'].includes(value.operation)) {
    throw new Error('installation pending record is invalid');
  }
  const manifest = validateInstallationManifest(value.manifest);
  const paths = expectedPaths(manifest);
  const allowedDirectories = [manifest.systemdUnitDir, manifest.pluginsRoot, path.dirname(paths.link)];
  if (!exact(value.paths, NAMES) || JSON.stringify(value.paths) !== JSON.stringify(paths)
    || value.receiptPath !== path.join(manifest.stateRoot, 'install-receipt.json')
    || !exact(value.files, NAMES) || !NAMES.every((name) => validSnapshot(value.files[name], name === 'link'))
    || !validSnapshot(value.receipt)
    || !Array.isArray(value.createdDirectories)
    || value.createdDirectories.some((directory) => typeof directory !== 'string' || !path.isAbsolute(directory)
      || !allowedDirectories.some((target) => {
        const relative = path.relative(directory, target);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      }))
    || !exact(value.unitState, ['timerEnabled', 'timerActive', 'serviceActive'])
    || !['disabled', 'enabled', 'enabled-runtime'].includes(value.unitState.timerEnabled)
    || typeof value.unitState.timerActive !== 'boolean' || value.unitState.serviceActive !== false
    || containsCredentialMaterial(value)
    || [...Object.values(value.files), value.receipt].some(decodedCredential)) {
    throw new Error('installation pending record is invalid');
  }
  return value;
}

export function pendingPath(stateRoot) {
  return path.join(stateRoot, 'install-pending.json');
}

export function loadPending(filePath) {
  const saved = snapshot(filePath);
  if (saved.kind === 'absent') return null;
  if (saved.kind !== 'file') throw new Error('installation pending record is unsafe');
  return validatePending(JSON.parse(Buffer.from(saved.bytes, 'base64').toString('utf8')));
}

export function writePending(filePath, value) {
  validatePending(value);
  writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function clearPending(filePath) {
  removeDurable(filePath);
}

function invoke(run, command, args, env) {
  return run(command, args, { encoding: 'utf8', env });
}

function checked(run, command, args, env) {
  const result = invoke(run, command, args, env);
  if (!result || result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} failed`);
}

export function recoverPending(filePath, pending, { run, env }) {
  validatePending(pending);
  const systemctl = pending.manifest.systemctlPath;
  invoke(run, systemctl, ['--user', 'disable', '--now', TIMER], env);
  invoke(run, systemctl, ['--user', 'stop', SERVICE], env);
  const enabled = invoke(run, systemctl, ['--user', 'is-enabled', TIMER], env);
  if (/^(?:enabled|enabled-runtime)$/.test(String(enabled?.stdout || '').trim())) {
    throw new Error(`cannot recover while ${TIMER} is enabled`);
  }
  for (const unit of [TIMER, SERVICE]) {
    const active = invoke(run, systemctl, ['--user', 'is-active', unit], env);
    if (active?.status === 0 || String(active?.stdout || '').trim() === 'active') {
      throw new Error(`cannot recover while ${unit} is active`);
    }
  }
  for (const name of [...NAMES].reverse()) restoreSnapshot(pending.paths[name], pending.files[name]);
  restoreSnapshot(pending.receiptPath, pending.receipt);
  checked(run, systemctl, ['--user', 'daemon-reload'], env);
  if (pending.unitState.timerEnabled !== 'disabled') {
    checked(run, systemctl, [
      '--user', 'enable', ...(pending.unitState.timerEnabled === 'enabled-runtime' ? ['--runtime'] : []),
      ...(pending.unitState.timerActive ? ['--now'] : []), TIMER,
    ], env);
  } else if (pending.unitState.timerActive) checked(run, systemctl, ['--user', 'start', TIMER], env);
  if (pending.operation === 'install') removeCreatedDirectories(pending.createdDirectories);
  return pending;
}
