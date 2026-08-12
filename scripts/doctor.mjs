import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  containsCredentialMaterial, defaultManifestPath, loadInstalledComposition,
} from '../extensions/installation.mjs';
import { guardHealthDiagnostics, guardHealthFailures } from '../core/guard-health.mjs';
import { digest, snapshot, validateReceipt } from './install-state.mjs';
import { loadPending, pendingPath } from './pending.mjs';

const RUN_ID = /^run_[a-f0-9]{24}$/;

function installationFailures(composition, manifestPath) {
  if (!composition.manifest) return [];
  const manifest = composition.manifest;
  try {
    if (loadPending(pendingPath(manifest.stateRoot))) return ['installation recovery is pending'];
  } catch (error) { return [`installation integrity failed: ${error.message}`]; }
  const paths = {
    manifest: manifestPath,
    service: path.join(manifest.systemdUnitDir, 'omp-bounded-guard.service'),
    timer: path.join(manifest.systemdUnitDir, 'omp-bounded-guard.timer'),
    lock: path.join(manifest.pluginsRoot, 'omp-plugins.lock.json'),
    package: path.join(manifest.pluginsRoot, 'package.json'),
    bunLock: path.join(manifest.pluginsRoot, 'bun.lock'),
    bunLockb: path.join(manifest.pluginsRoot, 'bun.lockb'),
    link: path.join(manifest.pluginsRoot, 'node_modules', 'omp-bounded'),
  };
  try {
    const saved = snapshot(path.join(manifest.stateRoot, 'install-receipt.json'));
    if (saved.kind !== 'file') throw new Error('receipt unavailable');
    const receipt = validateReceipt(JSON.parse(Buffer.from(saved.bytes, 'base64').toString('utf8')), {
      packageRoot: manifest.packageRoot, paths,
      allowedCreatedDirectories: [manifest.systemdUnitDir, manifest.pluginsRoot, path.dirname(paths.link)],
    });
    if (containsCredentialMaterial(receipt) || Object.values(receipt.original).some((original) => {
      if (original.kind !== 'file') return false;
      const text = Buffer.from(original.bytes, 'base64').toString('utf8');
      try { return containsCredentialMaterial(JSON.parse(text)); } catch { return containsCredentialMaterial(text); }
    })) throw new Error('receipt contains credential material');
    for (const [name, key] of [['manifest', 'manifestDigest'], ['service', 'serviceDigest'], ['timer', 'timerDigest']]) {
      if (snapshot(paths[name]).kind !== 'file'
        || digest(fs.readFileSync(paths[name])) !== receipt.installed[key]) throw new Error(`${name} digest mismatch`);
    }
    const link = fs.lstatSync(paths.link, { throwIfNoEntry: false });
    if (!link?.isSymbolicLink() || fs.realpathSync(paths.link) !== receipt.installed.linkTarget) throw new Error('plugin link mismatch');
    const lock = JSON.parse(fs.readFileSync(paths.lock, 'utf8'));
    if (digest(fs.readFileSync(paths.lock)) !== receipt.installed.lockDigest
      || JSON.stringify(lock?.plugins?.['omp-bounded']) !== JSON.stringify(receipt.installed.runtimeEntry)
      || digest(JSON.stringify(lock?.settings?.['omp-bounded'] ?? null)) !== receipt.installed.settingsDigest) {
      throw new Error('plugin registry or settings mismatch');
    }
    for (const [name, installedKey] of [
      ['package', 'packageDigest'], ['bunLock', 'bunLockDigest'], ['bunLockb', 'bunLockbDigest'],
    ]) {
      const savedFile = snapshot(paths[name]);
      const currentDigest = savedFile.kind === 'file' ? savedFile.digest : null;
      if (currentDigest !== receipt.installed[installedKey]) throw new Error(`${name} digest mismatch`);
    }
    return [];
  } catch (error) { return [`installation integrity failed: ${error.message}`]; }
}

export async function doctor({ manifestPath = defaultManifestPath(), load = loadInstalledComposition } = {}) {
  const composition = load(manifestPath);
  const controller = await composition.controller.doctor();
  const guard = await composition.guard.status();
  const failures = [...new Set([
    ...(controller.failures || []), ...installationFailures(composition, manifestPath), ...guardHealthFailures(guard),
  ])];
  if (guard.drift === true) failures.push('guard drift detected');
  return { status: failures.length ? 'blocked' : 'ready', failures, diagnostics: guardHealthDiagnostics(guard) };
}

export async function reconcile({ manifestPath = defaultManifestPath(), load = loadInstalledComposition } = {}) {
  const composition = load(manifestPath);
  const result = await composition.guard.reconcile();
  if (result?.status === 'controller-required') {
    await composition.controller.status();
    composition.guard.recordHeartbeat?.();
    return { status: 'protected', reason: result.reason };
  }
  composition.guard.recordHeartbeat?.();
  return result;
}

export async function deadline({ manifestPath = defaultManifestPath(), runId, load = loadInstalledComposition } = {}) {
  if (!RUN_ID.test(runId || '')) throw new Error('deadline runId is invalid');
  const composition = load(manifestPath);
  const result = await composition.guard.deadline(runId);
  composition.guard.recordHeartbeat?.();
  return result;
}

async function main(argv) {
  const action = argv.shift();
  const index = argv.indexOf('--manifest');
  if (index >= 0 && (!argv[index + 1] || argv[index + 1].startsWith('--'))) throw new Error('--manifest requires a value');
  const manifestPath = index >= 0 ? path.resolve(argv[index + 1]) : defaultManifestPath();
  if (action === 'doctor') return doctor({ manifestPath });
  if (action === 'reconcile') return reconcile({ manifestPath });
  if (action === 'deadline') {
    const runIndex = argv.indexOf('--run-id');
    if (runIndex < 0 || !argv[runIndex + 1] || argv[runIndex + 1].startsWith('--')) {
      throw new Error('deadline requires --run-id run_<24 lowercase hex>');
    }
    return deadline({ manifestPath, runId: argv[runIndex + 1] });
  }
  throw new Error('usage: doctor.mjs doctor|reconcile [--manifest /absolute/installation.json] | deadline --manifest /absolute/installation.json --run-id run_<24 lowercase hex>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
