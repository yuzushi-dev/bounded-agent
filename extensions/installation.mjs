import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createSystemdGuard } from '../adapters/systemd.mjs';
import { createController } from '../core/controller.mjs';
import { deriveOmpPaths } from './omp-paths.mjs';

const CONTROLLER_FIELDS = [
  'statePath', 'deliveryRoot', 'inputRoot', 'qualificationPaths', 'worker', 'verifierCommand',
  'bwrapPath', 'prlimitPath', 'flockPath', 'runtimeMounts',
];
const MANIFEST_FIELDS = [
  'schema', 'packageRoot', 'nodePath', 'ompPath', 'ompRoot', 'pluginsRoot', 'stateRoot', 'systemdUnitDir',
  'systemctlPath', 'systemdRunPath', 'controller', 'hostAdmissionDefaults',
];
const HOST_DEFAULT_FIELDS = [
  'boundedContext', 'verifier', 'requiredGates', 'retries', 'stopPolicy', 'routing', 'phase',
];
const CREDENTIAL_KEY = /(?:auth(?:entication|orization)?|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|cookie|credential|passphrase|password|secret|session[_-]?key|token)/i;
const PROVIDER_CREDENTIAL = /(?:\bBearer\s+\S+|\bsk-(?:ant-)?[A-Za-z0-9._-]{12,}|\bsk_(?:live|test)_[A-Za-z0-9]{12,}|\bgh[opusr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bnpm_[A-Za-z0-9]{20,}|\bhf_[A-Za-z0-9]{20,}|\bAKIA[A-Z0-9]{16}|\bAIza[0-9A-Za-z_-]{20,}|\bglpat-[A-Za-z0-9_-]{12,}|\bxox[baprs]-[A-Za-z0-9-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

function exact(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

export function containsCredentialMaterial(value, key = '') {
  if (CREDENTIAL_KEY.test(key)) return true;
  if (Array.isArray(value)) return value.some((item) => containsCredentialMaterial(item));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([name, item]) => containsCredentialMaterial(item, name));
  }
  return typeof value === 'string' && (PROVIDER_CREDENTIAL.test(value)
    || /^--?(?:auth(?:entication|orization)?|api[-_]?key|access[-_]?key|client[-_]?secret|private[-_]?key|cookie|credential|passphrase|password|secret|session[-_]?key|token)(?:=|$)/i.test(value)
    || /^(?:[A-Z0-9_]*(?:AUTH|API_KEY|ACCESS_KEY|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|SECRET|TOKEN)[A-Z0-9_]*)=/i.test(value)
    || /\b(?:authorization|proxy-authorization|x-api-key)\s*:/i.test(value)
    || /^(?:[a-z0-9-]*api-key|[a-z0-9-]*subscription-key)\s*:/i.test(value)
    || /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value)
    || /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/.test(value));
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || fs.realpathSync(filePath) !== filePath
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`${label} must be a private non-symlink file`);
  }
}

function safeDirectory(directory, label, privateMode = false) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
    || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`${label} is unsafe`);
  }
}

export function defaultManifestPath({ home = os.homedir(), env = process.env } = {}) {
  return path.join(deriveOmpPaths({ home, env }).stateRoot, 'installation.json');
}

export function validateInstallationManifest(manifest) {
  const controller = manifest?.controller;
  const defaults = manifest?.hostAdmissionDefaults;
  const paths = controller?.qualificationPaths;
  const command = (value) => exact(value, ['command', 'args'])
    && typeof value.command === 'string' && path.isAbsolute(value.command)
    && Array.isArray(value.args) && value.args.every((item) => typeof item === 'string');
  const chain = (value) => exact(value, ['role', 'family', 'selectors'])
    && ['task', 'reviewer'].includes(value.role) && typeof value.family === 'string' && value.family.length > 0
    && Array.isArray(value.selectors) && value.selectors.length > 0
    && value.selectors.every((item) => typeof item === 'string' && item.length > 0);
  if (!exact(manifest, MANIFEST_FIELDS) || manifest.schema !== 'omp-bounded-installation/v1'
    || !exact(controller, CONTROLLER_FIELDS)
    || !exact(paths, ['sources', 'config', 'suite', 'review', 'capabilities', 'probe', 'node'])
    || !paths.sources || Array.isArray(paths.sources) || Object.keys(paths.sources).length === 0
    || Object.entries(paths.sources).some(([name, value]) => !/^[a-z][a-z0-9_-]*$/i.test(name) || typeof value !== 'string')
    || !command(controller.worker) || !command(controller.verifierCommand)
    || !Array.isArray(controller.runtimeMounts) || controller.runtimeMounts.length === 0
    || controller.runtimeMounts.some((value) => !exact(value, ['source', 'target'])
      || !path.isAbsolute(value.source) || !path.isAbsolute(value.target))
    || !exact(defaults, HOST_DEFAULT_FIELDS)
    || !exact(defaults?.boundedContext, ['sessionPath', 'readPaths', 'maxBytes'])
    || typeof defaults.boundedContext.sessionPath !== 'string'
    || !Array.isArray(defaults.boundedContext.readPaths)
    || defaults.boundedContext.readPaths.some((value) => typeof value !== 'string')
    || !Number.isSafeInteger(defaults.boundedContext.maxBytes) || defaults.boundedContext.maxBytes < 1
    || !exact(defaults.verifier, ['id', 'digest']) || typeof defaults.verifier.id !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(defaults.verifier.digest || '')
    || !Array.isArray(defaults.requiredGates) || defaults.requiredGates.some((value) => typeof value !== 'string')
    || !exact(defaults.retries, ['request', 'worker', 'transport', 'semantic'])
    || Object.values(defaults.retries || {}).some((value) => !Number.isSafeInteger(value) || value < 0)
    || !exact(defaults.stopPolicy, ['onFailure', 'partialSuccess'])
    || typeof defaults.stopPolicy.onFailure !== 'string' || typeof defaults.stopPolicy.partialSuccess !== 'string'
    || !exact(defaults.routing, ['reviewerFamily', 'chains'])
    || typeof defaults.routing.reviewerFamily !== 'string'
    || !Array.isArray(defaults.routing.chains) || defaults.routing.chains.length < 2
    || defaults.routing.chains.some((value) => !chain(value))
    || !['dispatch', 'review'].includes(defaults.phase)
    || containsCredentialMaterial(manifest)) {
    throw new Error(containsCredentialMaterial(manifest) ? 'installation manifest contains credential material' : 'installation manifest is invalid');
  }
  for (const name of [
    'packageRoot', 'nodePath', 'ompPath', 'ompRoot', 'pluginsRoot', 'stateRoot', 'systemdUnitDir', 'systemctlPath', 'systemdRunPath',
  ]) {
    if (typeof manifest[name] !== 'string' || !path.isAbsolute(manifest[name]) || path.normalize(manifest[name]) !== manifest[name]) {
      throw new Error(`installation manifest ${name} is invalid`);
    }
  }
  for (const name of ['statePath', 'deliveryRoot', 'inputRoot', 'bwrapPath', 'prlimitPath', 'flockPath']) {
    if (typeof controller[name] !== 'string' || !path.isAbsolute(controller[name])
      || path.normalize(controller[name]) !== controller[name]) throw new Error(`installation manifest controller ${name} is invalid`);
  }
  for (const commandValue of [controller.worker, controller.verifierCommand]) {
    if (path.normalize(commandValue.command) !== commandValue.command) throw new Error('installation manifest command is invalid');
  }
  if (controller.runtimeMounts.some(({ source, target }) => path.normalize(source) !== source || path.normalize(target) !== target)) {
    throw new Error('installation manifest runtime mount is invalid');
  }
  if (path.dirname(manifest.controller.statePath) !== manifest.stateRoot
    || !inside(manifest.stateRoot, manifest.controller.statePath)
    || !inside(manifest.stateRoot, manifest.controller.deliveryRoot)
    || !inside(manifest.stateRoot, manifest.controller.inputRoot)
    || !Object.values(manifest.controller.qualificationPaths?.sources || {}).every((item) => inside(manifest.stateRoot, item))
    || !['config', 'suite', 'review', 'capabilities', 'probe', 'node']
      .every((name) => inside(manifest.stateRoot, manifest.controller.qualificationPaths?.[name] || ''))) {
    throw new Error('installation manifest uses an unsafe state root');
  }
  return manifest;
}

export function loadInstallationManifest(filePath = defaultManifestPath()) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('installation manifest path must be absolute');
  }
  try { safeFile(filePath, 'installation manifest'); }
  catch (error) {
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) throw new Error('installation manifest must not be a symlink');
    throw new Error(`installation manifest is unavailable: ${error.message}`);
  }
  const manifest = validateInstallationManifest(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  safeDirectory(manifest.stateRoot, 'installation state root', true);
  safeDirectory(manifest.pluginsRoot, 'OMP plugin root');
  safeDirectory(path.join(manifest.pluginsRoot, 'node_modules'), 'OMP plugin node_modules root');
  safeDirectory(manifest.systemdUnitDir, 'systemd unit root');
  return manifest;
}

export function loadInstalledComposition(filePath = defaultManifestPath(), { run = spawnSync } = {}) {
  const manifest = loadInstallationManifest(filePath);
  const guard = createSystemdGuard({
    statePath: manifest.controller.statePath,
    stateRoot: manifest.stateRoot,
    deliveryRoot: path.join(manifest.controller.deliveryRoot, 'receipts'),
    systemctlPath: manifest.systemctlPath,
    systemdRunPath: manifest.systemdRunPath,
    nodePath: manifest.nodePath,
    doctorPath: path.join(manifest.packageRoot, 'scripts', 'doctor.mjs'),
    manifestPath: filePath,
    flockPath: manifest.controller.flockPath,
    run: (command, args) => run(command, args, { encoding: 'utf8' }),
  });
  const controller = createController({
    ...manifest.controller,
    nodePath: manifest.nodePath,
    clock: () => new Date().toISOString(),
    guard,
  });
  return Object.freeze({ controller, guard, hostAdmissionDefaults: manifest.hostAdmissionDefaults, manifest });
}
