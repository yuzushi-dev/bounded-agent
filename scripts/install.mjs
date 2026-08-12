import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderGuardService } from '../adapters/systemd.mjs';
import { containsCredentialMaterial, validateInstallationManifest } from '../extensions/installation.mjs';
import { deriveOmpPaths } from '../extensions/omp-paths.mjs';
import {
  RECEIPT_SCHEMA, assertSafeChain, assertSafeDirectory, digest, removeCreatedDirectories,
  restoreSnapshot, snapshot, validateReceipt, withInstallLock, writeAtomic,
} from './install-state.mjs';
import {
  PENDING_SCHEMA, clearPending, loadPending, pendingPath, recoverPending, writePending,
} from './pending.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'omp-bounded-guard.service';
const TIMER = 'omp-bounded-guard.timer';
const SNAPSHOT_NAMES = ['manifest', 'service', 'timer', 'lock', 'package', 'bunLock', 'bunLockb', 'link'];

function checked(run, command, args, environment) {
  const result = run(command, args, { encoding: 'utf8', env: environment });
  if (!result || result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function reconcileGuard(run, systemctlPath, environment) {
  checked(run, systemctlPath, ['--user', 'start', SERVICE], environment);
  const result = checked(run, systemctlPath, [
    '--user', 'show', SERVICE,
    '--property=Result', '--property=ExecMainStatus', '--property=ExecMainExitTimestampMonotonic',
  ], environment);
  if (!/^Result=success$/m.test(result)
    || !/^ExecMainStatus=0$/m.test(result)
    || !/^ExecMainExitTimestampMonotonic=[1-9]\d*$/m.test(result)) {
    throw new Error('bounded guard reconciliation did not succeed');
  }
}

function verifyHeartbeat(statePath) {
  const heartbeatPath = `${statePath}.guard-heartbeat`;
  const stat = fs.lstatSync(heartbeatPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('bounded guard heartbeat is unavailable or unsafe');
  }
  const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
  const now = Number(process.hrtime.bigint() / 1_000n);
  if (heartbeat?.schema !== 'omp-bounded-guard-heartbeat/v1'
    || Object.keys(heartbeat).sort().join(',') !== 'monotonicUs,schema'
    || !Number.isSafeInteger(heartbeat.monotonicUs) || heartbeat.monotonicUs <= 0
    || heartbeat.monotonicUs > now || now - heartbeat.monotonicUs > 120_000_000) {
    throw new Error('bounded guard heartbeat is stale or invalid');
  }
}

function timerState(run, systemctlPath, environment) {
  const enabled = run(systemctlPath, ['--user', 'is-enabled', TIMER], { encoding: 'utf8', env: environment });
  const active = run(systemctlPath, ['--user', 'is-active', TIMER], { encoding: 'utf8', env: environment });
  return {
    enabled: /^(?:enabled|enabled-runtime)$/.test(String(enabled?.stdout || '').trim())
      ? String(enabled.stdout).trim() : 'disabled',
    active: active?.status === 0 && String(active.stdout || '').trim() === 'active',
  };
}

function restoreTimerState(run, systemctlPath, state, environment) {
  if (state.enabled !== 'disabled') {
    checked(run, systemctlPath, [
      '--user', 'enable', ...(state.enabled === 'enabled-runtime' ? ['--runtime'] : []), ...(state.active ? ['--now'] : []), TIMER,
    ], environment);
  } else if (state.active) checked(run, systemctlPath, ['--user', 'start', TIMER], environment);
}

function executable(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid() || stat.uid === 0;
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 || !owned) {
    throw new Error(`${label} is not a safe executable`);
  }
  return resolved;
}

function pathsFor(paths) {
  return {
    manifest: path.join(paths.stateRoot, 'installation.json'),
    receipt: path.join(paths.stateRoot, 'install-receipt.json'),
    service: path.join(paths.systemdUnitDir, SERVICE),
    timer: path.join(paths.systemdUnitDir, TIMER),
    lock: path.join(paths.pluginsRoot, 'omp-plugins.lock.json'),
    package: path.join(paths.pluginsRoot, 'package.json'),
    bunLock: path.join(paths.pluginsRoot, 'bun.lock'),
    bunLockb: path.join(paths.pluginsRoot, 'bun.lockb'),
    link: path.join(paths.pluginsRoot, 'node_modules', 'omp-bounded'),
  };
}

function missingDirectories(targets) {
  const missing = new Set();
  for (const target of targets) {
    for (let current = target; !fs.existsSync(current); current = path.dirname(current)) {
      missing.add(current);
      if (path.dirname(current) === current) break;
    }
  }
  return [...missing].sort((left, right) => left.length - right.length);
}

function safeSnapshot(filePath, options) {
  const saved = snapshot(filePath, options);
  if (saved.kind === 'file') {
    const text = Buffer.from(saved.bytes, 'base64').toString('utf8');
    let value = text;
    try { value = JSON.parse(text); } catch {}
    if (containsCredentialMaterial(value)) throw new Error(`${path.basename(filePath)} contains credential material`);
  }
  return saved;
}

function readReceipt(filePath, expected) {
  if (!fs.existsSync(filePath)) return null;
  const saved = snapshot(filePath);
  const receipt = JSON.parse(Buffer.from(saved.bytes, 'base64').toString('utf8'));
  validateReceipt(receipt, expected);
  if (receiptCredentials(receipt)) throw new Error('installation receipt contains credential material');
  return receipt;
}

function receiptCredentials(receipt) {
  if (containsCredentialMaterial(receipt)) return true;
  return Object.values(receipt.original || {}).some((saved) => {
    if (saved.kind !== 'file') return false;
    const text = Buffer.from(saved.bytes, 'base64').toString('utf8');
    try { return containsCredentialMaterial(JSON.parse(text)); } catch { return containsCredentialMaterial(text); }
  });
}

function verifyLinked(paths, packageRoot, packageVersion) {
  assertSafeDirectory(path.dirname(paths.lock), 'OMP plugin directory');
  assertSafeDirectory(path.dirname(paths.link), 'OMP plugin node_modules directory');
  const link = fs.lstatSync(paths.link, { throwIfNoEntry: false });
  if (!link?.isSymbolicLink() || fs.realpathSync(paths.link) !== packageRoot) throw new Error('OMP plugin link verification failed');
  const lockSnapshot = safeSnapshot(paths.lock);
  if (lockSnapshot.kind !== 'file') throw new Error('OMP plugin registry verification failed');
  const lock = JSON.parse(Buffer.from(lockSnapshot.bytes, 'base64').toString('utf8'));
  const entry = lock?.plugins?.['omp-bounded'];
  if (!entry || Object.keys(entry).sort().join(',') !== 'enabled,enabledFeatures,version'
    || entry.enabled !== true || entry.enabledFeatures !== null || entry.version !== packageVersion) {
    throw new Error('OMP plugin registry verification failed');
  }
  if (containsCredentialMaterial(lock)) throw new Error('OMP plugin configuration contains credential material');
  return { entry, settingsDigest: digest(JSON.stringify(lock.settings?.['omp-bounded'] ?? null)) };
}

function installedFileDigest(filePath) {
  const saved = safeSnapshot(filePath);
  return saved.kind === 'file' ? saved.digest : null;
}

function requirePending(filePath, expectedDigest) {
  const current = snapshot(filePath);
  if (current.kind !== 'file' || current.digest !== expectedDigest) {
    throw new Error('installation pending transaction changed during reconciliation');
  }
}

function verifyInstalledReceipt(receipt, owned, packageRoot, packageVersion) {
  for (const [name, key] of [['manifest', 'manifestDigest'], ['service', 'serviceDigest'], ['timer', 'timerDigest']]) {
    if (installedFileDigest(owned[name]) !== receipt.installed[key]) {
      throw new Error(`${name} changed during installation reconciliation`);
    }
  }
  for (const [name, key] of [
    ['package', 'packageDigest'], ['bunLock', 'bunLockDigest'], ['bunLockb', 'bunLockbDigest'],
  ]) {
    if (installedFileDigest(owned[name]) !== receipt.installed[key]) {
      throw new Error(`${name} changed during installation reconciliation`);
    }
  }
  if (digest(fs.readFileSync(owned.lock)) !== receipt.installed.lockDigest) {
    throw new Error('plugin registry changed during installation reconciliation');
  }
  const linked = verifyLinked(owned, packageRoot, packageVersion);
  if (JSON.stringify(linked.entry) !== JSON.stringify(receipt.installed.runtimeEntry)
    || linked.settingsDigest !== receipt.installed.settingsDigest) {
    throw new Error('plugin registration changed during installation reconciliation');
  }
}

export { deriveOmpPaths };

export async function install({
  home = os.homedir(), env = process.env, packageRoot = PACKAGE_ROOT, config,
  ompPath, systemctlPath = '/usr/bin/systemctl', systemdRunPath = '/usr/bin/systemd-run', run = spawnSync,
} = {}) {
  const paths = deriveOmpPaths({ home, env });
  const resolvedPackageRoot = fs.realpathSync(packageRoot);
  if (!fs.statSync(resolvedPackageRoot).isDirectory()) throw new Error('package root is invalid');
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(resolvedPackageRoot, 'package.json'), 'utf8'));
  if (packageMetadata?.name !== 'omp-bounded' || typeof packageMetadata.version !== 'string') {
    throw new Error('package metadata is invalid');
  }
  const nodePath = executable(process.execPath, 'Node executable');
  const resolvedOmpPath = executable(ompPath, 'OMP executable');
  const resolvedSystemctlPath = executable(systemctlPath, 'systemctl executable');
  const resolvedSystemdRunPath = executable(systemdRunPath, 'systemd-run executable');
  if (!config || typeof config !== 'object') throw new Error('qualified installation config is required');
  assertSafeChain(home, paths.stateRoot, 'state root');
  if (!fs.existsSync(paths.stateRoot)) throw new Error('qualified state root is unavailable');
  assertSafeDirectory(paths.stateRoot, 'state root', { privateMode: true });
  assertSafeChain(home, paths.systemdUnitDir, 'systemd unit directory');
  assertSafeChain(home, paths.pluginsRoot, 'OMP plugin directory');
  const owned = pathsFor(paths);
  const manifest = validateInstallationManifest({
    schema: 'omp-bounded-installation/v1', packageRoot: resolvedPackageRoot, nodePath,
    ompPath: resolvedOmpPath, ompRoot: paths.ompRoot, pluginsRoot: paths.pluginsRoot, stateRoot: paths.stateRoot,
    systemdUnitDir: paths.systemdUnitDir, systemctlPath: resolvedSystemctlPath,
    systemdRunPath: resolvedSystemdRunPath,
    controller: structuredClone(config.controller),
    hostAdmissionDefaults: structuredClone(config.hostAdmissionDefaults),
  });
  const service = renderGuardService({
    nodePath, doctorPath: path.join(resolvedPackageRoot, 'scripts', 'doctor.mjs'),
    manifestPath: owned.manifest, stateRoot: paths.stateRoot,
  });
  const timer = fs.readFileSync(path.join(resolvedPackageRoot, 'systemd', TIMER), 'utf8');
  const commandEnv = { ...process.env, ...env, HOME: home };
  const pendingFile = pendingPath(paths.stateRoot);
  let rollbackContext;
  const result = await withInstallLock(paths.stateRoot, manifest.controller.flockPath, nodePath, async () => {
    const startupPending = loadPending(pendingFile);
    if (startupPending && (startupPending.manifest.stateRoot !== manifest.stateRoot
      || startupPending.manifest.controller.statePath !== manifest.controller.statePath
      || startupPending.manifest.controller.flockPath !== manifest.controller.flockPath
      || startupPending.manifest.nodePath !== manifest.nodePath
      || startupPending.manifest.packageRoot !== manifest.packageRoot)) {
      throw new Error('installation pending record does not match this installation');
    }
    if (startupPending) {
      recoverPending(pendingFile, startupPending, { run, env: commandEnv });
      clearPending(pendingFile);
    }
    const existingService = run(resolvedSystemctlPath, ['--user', 'is-active', SERVICE], {
      encoding: 'utf8', env: commandEnv,
    });
    if (existingService?.status === 0 && String(existingService.stdout || '').trim() === 'active') {
      throw new Error('preexisting bounded guard service is active');
    }
    const transaction = Object.fromEntries(SNAPSHOT_NAMES.map((name) => [
      name, safeSnapshot(owned[name], name === 'link' ? { symlinkOnly: true } : undefined),
    ]));
    const transactionReceipt = safeSnapshot(owned.receipt);
    const existing = readReceipt(owned.receipt, {
      packageRoot: resolvedPackageRoot,
      paths: Object.fromEntries(Object.entries(owned).filter(([name]) => name !== 'receipt')),
      allowedCreatedDirectories: [paths.systemdUnitDir, paths.pluginsRoot, path.dirname(owned.link)],
    });
    const original = existing?.original ?? transaction;
    const transactionDirectories = missingDirectories([
      paths.systemdUnitDir, paths.pluginsRoot, path.dirname(owned.link),
    ]);
    const createdDirectories = existing?.createdDirectories ?? transactionDirectories;
    const transactionSystemd = timerState(run, resolvedSystemctlPath, commandEnv);
    const priorSystemd = existing?.priorSystemd ?? transactionSystemd;
    rollbackContext = { transaction, transactionReceipt, transactionDirectories, transactionSystemd };
    writePending(pendingFile, {
      schema: PENDING_SCHEMA,
      operation: 'install',
      manifest,
      paths: Object.fromEntries(Object.entries(owned).filter(([name]) => name !== 'receipt')),
      files: transaction,
      receiptPath: owned.receipt,
      receipt: transactionReceipt,
      createdDirectories: transactionDirectories,
      unitState: {
        timerEnabled: transactionSystemd.enabled,
        timerActive: transactionSystemd.active,
        serviceActive: false,
      },
    });
    rollbackContext.pendingDigest = snapshot(pendingFile).digest;
    let timerStopAttempted = false;
    let enableAttempted = false;
    let installationResult;
    try {
      fs.mkdirSync(paths.systemdUnitDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(paths.pluginsRoot, { recursive: true, mode: 0o700 });
      assertSafeDirectory(paths.systemdUnitDir, 'systemd unit directory');
      assertSafeDirectory(paths.pluginsRoot, 'OMP plugin directory');
      writeAtomic(owned.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
      writeAtomic(owned.service, service);
      writeAtomic(owned.timer, timer);
      checked(run, resolvedOmpPath, ['plugin', 'link', resolvedPackageRoot, '--scope', 'user'], commandEnv);
      const linked = verifyLinked(owned, resolvedPackageRoot, packageMetadata.version);
      const receipt = {
        schema: RECEIPT_SCHEMA,
        packageRoot: resolvedPackageRoot,
        createdDirectories,
        priorSystemd,
        paths: Object.fromEntries(Object.entries(owned).filter(([name]) => name !== 'receipt')),
        original,
        installed: {
          manifestDigest: digest(fs.readFileSync(owned.manifest)),
          serviceDigest: digest(service),
          timerDigest: digest(timer),
          lockDigest: digest(fs.readFileSync(owned.lock)),
          packageDigest: installedFileDigest(owned.package),
          bunLockDigest: installedFileDigest(owned.bunLock),
          bunLockbDigest: installedFileDigest(owned.bunLockb),
          linkTarget: resolvedPackageRoot,
          runtimeEntry: linked.entry,
          settingsDigest: linked.settingsDigest,
        },
      };
      if (receiptCredentials(receipt)) throw new Error('installation receipt contains credential material');
      writeAtomic(owned.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
      checked(run, resolvedSystemctlPath, ['--user', 'daemon-reload'], commandEnv);
      if (transactionSystemd.active) {
        timerStopAttempted = true;
        checked(run, resolvedSystemctlPath, ['--user', 'disable', '--now', TIMER], commandEnv);
      }
      enableAttempted = true;
      checked(run, resolvedSystemctlPath, ['--user', 'enable', TIMER], commandEnv);
      installationResult = { status: 'installed', manifestPath: owned.manifest };
    } catch (error) {
      const rollbackFailures = [];
      if (timerStopAttempted || enableAttempted) {
        try { checked(run, resolvedSystemctlPath, ['--user', 'disable', '--now', TIMER], commandEnv); }
        catch (failure) { rollbackFailures.push(failure); }
        try { checked(run, resolvedSystemctlPath, ['--user', 'stop', SERVICE], commandEnv); }
        catch (failure) { rollbackFailures.push(failure); }
        if (timerState(run, resolvedSystemctlPath, commandEnv).active) {
          throw new AggregateError([error, ...rollbackFailures], 'installation failed while the guard timer remained active');
        }
      }
      for (const name of [...SNAPSHOT_NAMES].reverse()) {
        try { restoreSnapshot(owned[name], transaction[name]); } catch (failure) { rollbackFailures.push(failure); }
      }
      try { restoreSnapshot(owned.receipt, transactionReceipt); } catch (failure) { rollbackFailures.push(failure); }
      try { checked(run, resolvedSystemctlPath, ['--user', 'daemon-reload'], commandEnv); } catch {}
      try { restoreTimerState(run, resolvedSystemctlPath, transactionSystemd, commandEnv); }
      catch (failure) { rollbackFailures.push(failure); }
      removeCreatedDirectories(transactionDirectories);
      if (rollbackFailures.length) {
        throw new AggregateError([error, ...rollbackFailures], 'installation failed and rollback was incomplete');
      }
      clearPending(pendingFile);
      throw error;
    }
    return installationResult;
  });
  let reconciliationError;
  try {
    reconcileGuard(run, resolvedSystemctlPath, commandEnv);
    verifyHeartbeat(manifest.controller.statePath);
    checked(run, resolvedSystemctlPath, ['--user', 'start', TIMER], commandEnv);
    const installedTimer = timerState(run, resolvedSystemctlPath, commandEnv);
    if (installedTimer.enabled !== 'enabled' || !installedTimer.active) {
      throw new Error('bounded guard timer did not activate');
    }
  } catch (error) { reconciliationError = error; }
  if (!reconciliationError) {
    await withInstallLock(paths.stateRoot, manifest.controller.flockPath, nodePath, async () => {
      requirePending(pendingFile, rollbackContext.pendingDigest);
      const receipt = readReceipt(owned.receipt, {
        packageRoot: resolvedPackageRoot,
        paths: Object.fromEntries(Object.entries(owned).filter(([name]) => name !== 'receipt')),
        allowedCreatedDirectories: [paths.systemdUnitDir, paths.pluginsRoot, path.dirname(owned.link)],
      });
      if (!receipt) throw new Error('installation receipt disappeared during reconciliation');
      verifyInstalledReceipt(receipt, owned, resolvedPackageRoot, packageMetadata.version);
      clearPending(pendingFile);
    });
    return result;
  }
  const rollbackFailures = [];
  try {
    await withInstallLock(paths.stateRoot, manifest.controller.flockPath, nodePath, async () => {
      requirePending(pendingFile, rollbackContext.pendingDigest);
      try { checked(run, resolvedSystemctlPath, ['--user', 'disable', '--now', TIMER], commandEnv); }
      catch (failure) { rollbackFailures.push(failure); }
      try { checked(run, resolvedSystemctlPath, ['--user', 'stop', SERVICE], commandEnv); }
      catch (failure) { rollbackFailures.push(failure); }
      const timerStillActive = timerState(run, resolvedSystemctlPath, commandEnv).active;
      const serviceState = run(resolvedSystemctlPath, ['--user', 'is-active', SERVICE], {
        encoding: 'utf8', env: commandEnv,
      });
      const serviceStillActive = serviceState?.status === 0
        || String(serviceState?.stdout || '').trim() === 'active';
      if (timerStillActive || serviceStillActive) {
        rollbackFailures.push(new Error('bounded guard units remained active'));
      } else {
        for (const name of [...SNAPSHOT_NAMES].reverse()) {
          try { restoreSnapshot(owned[name], rollbackContext.transaction[name]); }
          catch (failure) { rollbackFailures.push(failure); }
        }
        try { restoreSnapshot(owned.receipt, rollbackContext.transactionReceipt); }
        catch (failure) { rollbackFailures.push(failure); }
        try { checked(run, resolvedSystemctlPath, ['--user', 'daemon-reload'], commandEnv); } catch {}
        try { restoreTimerState(run, resolvedSystemctlPath, rollbackContext.transactionSystemd, commandEnv); }
        catch (failure) { rollbackFailures.push(failure); }
        removeCreatedDirectories(rollbackContext.transactionDirectories);
        if (!rollbackFailures.length) clearPending(pendingFile);
      }
    });
  } catch (failure) { rollbackFailures.push(failure); }
  if (rollbackFailures.length) {
    throw new AggregateError([reconciliationError, ...rollbackFailures],
      'installation reconciliation failed and rollback was incomplete');
  }
  throw reconciliationError;
}

export function parseInstallArgs(argv) {
  const index = argv.indexOf('--config');
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error('usage: install.mjs --config /absolute/qualified-installation.json [--omp /absolute/omp]');
  }
  const ompIndex = argv.indexOf('--omp');
  if (ompIndex >= 0 && (!argv[ompIndex + 1] || argv[ompIndex + 1].startsWith('--'))) throw new Error('--omp requires a value');
  return { configPath: path.resolve(argv[index + 1]), omp: ompIndex >= 0 ? argv[ompIndex + 1] : 'omp' };
}

function cli(argv) {
  const parsed = parseInstallArgs(argv);
  const config = JSON.parse(fs.readFileSync(parsed.configPath, 'utf8'));
  const resolved = parsed.omp.includes(path.sep) ? path.resolve(parsed.omp) : (process.env.PATH || '').split(path.delimiter)
    .map((directory) => path.join(directory, parsed.omp)).find((candidate) => fs.existsSync(candidate));
  if (!resolved) throw new Error('OMP executable was not found');
  return install({ config, ompPath: resolved });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
