import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSystemdGuard } from '../adapters/systemd.mjs';
import {
  containsCredentialMaterial, defaultManifestPath, loadInstallationManifest,
} from '../extensions/installation.mjs';
import {
  digest, restoreSnapshot, snapshot, validateReceipt, withInstallLock, writeAtomic,
} from './install-state.mjs';
import {
  PENDING_SCHEMA, clearPending, loadPending, pendingPath, recoverPending, writePending,
} from './pending.mjs';

const TIMER = 'omp-bounded-guard.timer';
const OWNED = ['manifest', 'service', 'timer', 'lock', 'package', 'bunLock', 'bunLockb', 'link'];

function runCommand(run, command, args, environment) {
  const result = run(command, args, { encoding: 'utf8', env: environment });
  if (!result) throw new Error(`${path.basename(command)} ${args.join(' ')} failed`);
  return result;
}

function checked(run, command, args, environment) {
  const result = runCommand(run, command, args, environment);
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function restoreTimerState(run, systemctlPath, state, environment) {
  if (state.enabled !== 'disabled') {
    checked(run, systemctlPath, [
      '--user', 'enable', ...(state.enabled === 'enabled-runtime' ? ['--runtime'] : []), ...(state.active ? ['--now'] : []), TIMER,
    ], environment);
  } else if (state.active) checked(run, systemctlPath, ['--user', 'start', TIMER], environment);
}

function timerState(run, systemctlPath, environment) {
  const enabled = runCommand(run, systemctlPath, ['--user', 'is-enabled', TIMER], environment);
  const active = runCommand(run, systemctlPath, ['--user', 'is-active', TIMER], environment);
  return {
    enabled: /^(?:enabled|enabled-runtime)$/.test(String(enabled.stdout || '').trim())
      ? String(enabled.stdout).trim() : 'disabled',
    active: active.status === 0 && String(active.stdout || '').trim() === 'active',
  };
}

function receiptFor(manifest, manifestPath) {
  const receiptPath = path.join(manifest.stateRoot, 'install-receipt.json');
  const saved = snapshot(receiptPath);
  if (saved.kind !== 'file') throw new Error('installation receipt is unsafe');
  const receipt = JSON.parse(Buffer.from(saved.bytes, 'base64').toString('utf8'));
  const paths = {
    manifest: manifestPath,
    service: path.join(manifest.systemdUnitDir, 'omp-bounded-guard.service'),
    timer: path.join(manifest.systemdUnitDir, TIMER),
    lock: path.join(manifest.pluginsRoot, 'omp-plugins.lock.json'),
    package: path.join(manifest.pluginsRoot, 'package.json'),
    bunLock: path.join(manifest.pluginsRoot, 'bun.lock'),
    bunLockb: path.join(manifest.pluginsRoot, 'bun.lockb'),
    link: path.join(manifest.pluginsRoot, 'node_modules', 'omp-bounded'),
  };
  validateReceipt(receipt, {
    packageRoot: manifest.packageRoot, paths,
    allowedCreatedDirectories: [manifest.systemdUnitDir, manifest.pluginsRoot, path.dirname(paths.link)],
  });
  if (containsCredentialMaterial(receipt) || Object.values(receipt.original).some((original) => {
    if (original.kind !== 'file') return false;
    const text = Buffer.from(original.bytes, 'base64').toString('utf8');
    try { return containsCredentialMaterial(JSON.parse(text)); } catch { return containsCredentialMaterial(text); }
  })) throw new Error('installation receipt contains credential material');
  return { receipt, receiptPath, paths };
}

function verifyOwned(receipt, paths) {
  for (const [name, key] of [['manifest', 'manifestDigest'], ['service', 'serviceDigest'], ['timer', 'timerDigest']]) {
    const stat = fs.lstatSync(paths[name], { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || digest(fs.readFileSync(paths[name])) !== receipt.installed[key]) {
      throw new Error(`${name} bytes no longer match the installation receipt`);
    }
  }
  const link = fs.lstatSync(paths.link, { throwIfNoEntry: false });
  if (!link?.isSymbolicLink() || fs.realpathSync(paths.link) !== receipt.installed.linkTarget) {
    throw new Error('OMP plugin link no longer matches the installation receipt');
  }
}

function restoreLock(receipt, lockPath) {
  const current = snapshot(lockPath);
  if (current.kind === 'file' && current.digest === receipt.installed.lockDigest) {
    restoreSnapshot(lockPath, receipt.original.lock);
    return;
  }
  if (current.kind !== 'file') throw new Error('OMP plugin registry no longer matches the installation receipt');
  const config = JSON.parse(Buffer.from(current.bytes, 'base64').toString('utf8'));
  if (JSON.stringify(config?.plugins?.['omp-bounded']) !== JSON.stringify(receipt.installed.runtimeEntry)) {
    throw new Error('OMP plugin registry no longer matches the installation receipt');
  }
  if (digest(JSON.stringify(config?.settings?.['omp-bounded'] ?? null)) !== receipt.installed.settingsDigest) {
    throw new Error('OMP plugin settings no longer match the installation receipt');
  }
  let original = null;
  let originalConfig;
  if (receipt.original.lock.kind === 'file') {
    originalConfig = JSON.parse(Buffer.from(receipt.original.lock.bytes, 'base64').toString('utf8'));
    original = originalConfig?.plugins?.['omp-bounded'] ?? null;
  }
  if (original === null) delete config.plugins['omp-bounded'];
  else config.plugins['omp-bounded'] = original;
  const hadSetting = Object.hasOwn(originalConfig?.settings ?? {}, 'omp-bounded');
  if (hadSetting) {
    config.settings ??= {};
    config.settings['omp-bounded'] = originalConfig.settings['omp-bounded'];
  } else if (config.settings && typeof config.settings === 'object' && !Array.isArray(config.settings)) {
    delete config.settings['omp-bounded'];
  }
  if (containsCredentialMaterial(config)) throw new Error('OMP plugin registry contains credential material');
  writeAtomic(lockPath, `${JSON.stringify(config, null, 2)}\n`, current.mode);
}

export async function uninstall({ manifestPath = defaultManifestPath(), run = spawnSync, env = process.env } = {}) {
  const pendingFile = pendingPath(path.dirname(manifestPath));
  const pendingHint = loadPending(pendingFile);
  if (pendingHint) {
    await withInstallLock(
      pendingHint.manifest.stateRoot,
      pendingHint.manifest.controller.flockPath,
      pendingHint.manifest.nodePath,
      async () => {
        const current = loadPending(pendingFile);
        if (!current) return;
        if (current.paths.manifest !== manifestPath
          || current.manifest.controller.statePath !== pendingHint.manifest.controller.statePath
          || current.manifest.controller.flockPath !== pendingHint.manifest.controller.flockPath) {
          throw new Error('installation pending record does not match this installation');
        }
        recoverPending(pendingFile, current, { run, env });
        clearPending(pendingFile);
      },
    );
    return uninstall({ manifestPath, run, env });
  }
  if (!manifestPath || !fs.lstatSync(manifestPath, { throwIfNoEntry: false })) return { status: 'absent' };
  const manifest = loadInstallationManifest(manifestPath);
  const guard = createSystemdGuard({
    statePath: manifest.controller.statePath, stateRoot: manifest.stateRoot,
    deliveryRoot: path.join(manifest.controller.deliveryRoot, 'receipts'),
    systemctlPath: manifest.systemctlPath, nodePath: manifest.nodePath,
    systemdRunPath: manifest.systemdRunPath,
    doctorPath: path.join(manifest.packageRoot, 'scripts', 'doctor.mjs'), manifestPath,
    flockPath: manifest.controller.flockPath,
    run: (command, args) => run(command, args, { encoding: 'utf8', env }),
  });
  const result = await withInstallLock(
    manifest.stateRoot, manifest.controller.flockPath, manifest.nodePath,
    async () => {
      const racedPending = loadPending(pendingFile);
      if (racedPending) {
        if (racedPending.paths.manifest !== manifestPath
          || racedPending.manifest.controller.statePath !== manifest.controller.statePath
          || racedPending.manifest.controller.flockPath !== manifest.controller.flockPath) {
          throw new Error('installation pending record does not match this installation');
        }
        recoverPending(pendingFile, racedPending, { run, env });
        clearPending(pendingFile);
        return { status: 'recovered' };
      }
      const { receipt, receiptPath, paths } = receiptFor(manifest, manifestPath);
      verifyOwned(receipt, paths);
      const current = Object.fromEntries(OWNED.map((name) => [name, snapshot(paths[name], { symlinkOnly: name === 'link' })]));
      const currentReceipt = snapshot(receiptPath);
      const currentSystemd = timerState(run, manifest.systemctlPath, env);
      const serviceState = runCommand(run, manifest.systemctlPath, ['--user', 'is-active', 'omp-bounded-guard.service'], env);
      if (serviceState.status === 0 || String(serviceState.stdout || '').trim() === 'active') {
        throw new Error('bounded guard service is active');
      }
      writePending(pendingFile, {
        schema: PENDING_SCHEMA,
        operation: 'uninstall',
        manifest,
        paths,
        files: current,
        receiptPath,
        receipt: currentReceipt,
        createdDirectories: receipt.createdDirectories,
        unitState: {
          timerEnabled: currentSystemd.enabled,
          timerActive: currentSystemd.active,
          serviceActive: false,
        },
      });
      let disableAttempted = false;
      let cleanupStarted = false;
      let safeToEnable = true;
      try {
        const protectedResult = await guard.rollback('uninstall', { lockHeld: true });
        if (protectedResult.status === 'controller-required') throw new Error('delivery recovery must complete before uninstall');
        disableAttempted = true;
        checked(run, manifest.systemctlPath, ['--user', 'disable', '--now', TIMER], env);
        for (const unit of [TIMER, 'omp-bounded-guard.service']) {
          const active = runCommand(run, manifest.systemctlPath, ['--user', 'is-active', unit], env);
          if (String(active.stdout || '').trim() === 'active' || active.status === 0) {
            throw new Error(`${unit} remained active after disable`);
          }
        }
        try { verifyOwned(receipt, paths); }
        catch (error) { safeToEnable = false; throw error; }
        const liveReceipt = snapshot(receiptPath);
        if (liveReceipt.kind !== 'file' || liveReceipt.digest !== currentReceipt.digest) {
          safeToEnable = false;
          throw new Error('installation receipt changed during uninstall');
        }
        cleanupStarted = true;
        restoreLock(receipt, paths.lock);
        restoreSnapshot(paths.link, receipt.original.link);
        for (const [name, installedKey] of [
          ['package', 'packageDigest'], ['bunLock', 'bunLockDigest'], ['bunLockb', 'bunLockbDigest'],
        ]) {
          if ((current[name].kind === 'absent' && receipt.installed[installedKey] === null)
            || (current[name].kind === 'file' && current[name].digest === receipt.installed[installedKey])) {
            restoreSnapshot(paths[name], receipt.original[name]);
          }
        }
        restoreSnapshot(paths.service, receipt.original.service);
        restoreSnapshot(paths.timer, receipt.original.timer);
        checked(run, manifest.systemctlPath, ['--user', 'daemon-reload'], env);
        restoreTimerState(run, manifest.systemctlPath, receipt.priorSystemd, env);
        restoreSnapshot(paths.manifest, receipt.original.manifest);
        fs.rmSync(receiptPath);
        fs.rmSync(`${manifest.controller.statePath}.deadline-evidence`, { force: true });
        fs.rmSync(`${manifest.controller.statePath}.guard-heartbeat`, { force: true });
        for (const directory of [...receipt.createdDirectories].reverse()) {
          try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; }
        }
        clearPending(pendingFile);
        return { status: 'uninstalled' };
      } catch (error) {
        const failures = [];
        if (cleanupStarted) {
          for (const name of OWNED) {
            try { restoreSnapshot(paths[name], current[name]); } catch (failure) { failures.push(failure); }
          }
          try { restoreSnapshot(receiptPath, currentReceipt); } catch (failure) { failures.push(failure); }
          try { checked(run, manifest.systemctlPath, ['--user', 'daemon-reload'], env); } catch (failure) { failures.push(failure); }
        }
        if (disableAttempted && safeToEnable) {
          try { checked(run, manifest.systemctlPath, ['--user', 'enable', '--now', TIMER], env); }
          catch (failure) { failures.push(failure); }
        }
        if (!failures.length) clearPending(pendingFile);
        if (failures.length) throw new AggregateError([error, ...failures], 'uninstall failed and rollback was incomplete');
        throw error;
      }
    },
  );
  if (result.status === 'recovered') {
    return uninstall({ manifestPath, run, env });
  }
  return result;
}

export function parseUninstallArgs(argv) {
  const index = argv.indexOf('--manifest');
  if (index >= 0 && (!argv[index + 1] || argv[index + 1].startsWith('--'))) throw new Error('--manifest requires a value');
  return { manifestPath: index >= 0 ? path.resolve(argv[index + 1]) : defaultManifestPath() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let parsed;
  try { parsed = parseUninstallArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  if (parsed) uninstall(parsed).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
