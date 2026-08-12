import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const RECEIPT_SCHEMA = 'omp-bounded-install-receipt/v2';
const OWNED_NAMES = ['manifest', 'service', 'timer', 'lock', 'package', 'bunLock', 'bunLockb', 'link'];

export function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function snapshot(filePath, { symlinkOnly = false } = {}) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return { kind: 'absent' };
  if (stat.isSymbolicLink()) {
    if (symlinkOnly) return { kind: 'symlink', target: fs.readlinkSync(filePath) };
    throw new Error(`${path.basename(filePath)} is unsafe`);
  }
  if (symlinkOnly || !stat.isFile() || (stat.mode & 0o022) !== 0
    || fs.realpathSync(filePath) !== filePath
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`${path.basename(filePath)} is unsafe`);
  }
  const bytes = fs.readFileSync(filePath);
  return { kind: 'file', mode: stat.mode & 0o777, bytes: bytes.toString('base64'), digest: digest(bytes) };
}

export function restoreSnapshot(filePath, saved) {
  const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (current && !current.isFile() && !current.isSymbolicLink()) {
    throw new Error(`${path.basename(filePath)} became unsafe`);
  }
  if (saved.kind === 'absent') {
    if (current) fs.rmSync(filePath);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (saved.kind === 'symlink') {
    if (current) fs.rmSync(filePath);
    fs.symlinkSync(saved.target, filePath);
    return;
  }
  const bytes = Buffer.from(saved.bytes, 'base64');
  if (digest(bytes) !== saved.digest) throw new Error('installation receipt snapshot digest mismatch');
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.restore`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', saved.mode);
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fchmodSync(descriptor, saved.mode);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filePath);
    const directory = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function writeAtomic(filePath, content, mode = 0o600) {
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode });
    fs.chmodSync(temporary, mode);
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filePath);
    const directory = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function removeDurable(filePath) {
  if (!fs.lstatSync(filePath, { throwIfNoEntry: false })) return;
  fs.rmSync(filePath);
  const directory = fs.openSync(path.dirname(filePath), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export async function withInstallLock(directory, flockPath, nodePath, operation) {
  assertSafeDirectory(directory, 'installation lock directory', { privateMode: true });
  const child = spawn(flockPath, [
    '-n', directory, nodePath, '-e', "process.stdout.write('LOCKED\\n');process.stdin.resume()",
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('LOCKED\n')) resolve();
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('installation lock is held')));
  });
  try { return await operation(); }
  finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

export function assertSafeDirectory(directory, label, { privateMode = false } = {}) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
    || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`${label} must be a host-owned non-symlink directory with safe permissions`);
  }
}

export function assertSafeChain(root, target, label) {
  assertSafeDirectory(root, 'home');
  const relative = path.relative(root, target);
  const insideRoot = !relative.startsWith('..') && !path.isAbsolute(relative);
  let current = insideRoot ? root : path.parse(target).root;
  const parts = (insideRoot ? relative : path.relative(current, target)).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
    const rootOwnedAncestor = stat.uid === 0 && ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (!owned && !rootOwnedAncestor)
      || (owned && (stat.mode & 0o022) !== 0)) {
      throw new Error(`${label} traverses an unsafe directory: ${current}`);
    }
  }
}

export function removeCreatedDirectories(directories) {
  for (const directory of [...directories].reverse()) {
    try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; }
  }
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function validSnapshot(value, link = false) {
  if (exact(value, ['kind']) && value.kind === 'absent') return true;
  if (link && exact(value, ['kind', 'target']) && value.kind === 'symlink' && typeof value.target === 'string') return true;
  return !link && exact(value, ['kind', 'mode', 'bytes', 'digest']) && value.kind === 'file'
    && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777
    && typeof value.bytes === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytes)
    && /^sha256:[a-f0-9]{64}$/.test(value.digest)
    && digest(Buffer.from(value.bytes, 'base64')) === value.digest;
}

export function validateReceipt(receipt, expected) {
  if (!exact(receipt, [
    'schema', 'packageRoot', 'paths', 'original', 'installed', 'createdDirectories', 'priorSystemd',
  ])
    || receipt.schema !== RECEIPT_SCHEMA || receipt.packageRoot !== expected.packageRoot
    || !exact(receipt.priorSystemd, ['enabled', 'active'])
    || !['disabled', 'enabled', 'enabled-runtime'].includes(receipt.priorSystemd.enabled)
    || typeof receipt.priorSystemd.active !== 'boolean'
    || !Array.isArray(receipt.createdDirectories)
    || receipt.createdDirectories.some((directory) => typeof directory !== 'string' || !path.isAbsolute(directory)
      || (expected.allowedCreatedDirectories && !expected.allowedCreatedDirectories.some((target) => {
        const relative = path.relative(directory, target);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      })))
    || !exact(receipt.paths, OWNED_NAMES) || JSON.stringify(receipt.paths) !== JSON.stringify(expected.paths)
    || !OWNED_NAMES.every((name) => typeof receipt.paths[name] === 'string' && path.isAbsolute(receipt.paths[name]))
    || !exact(receipt.original, OWNED_NAMES)
    || !OWNED_NAMES.every((name) => validSnapshot(receipt.original[name], name === 'link'))
    || !exact(receipt.installed, [
      'manifestDigest', 'serviceDigest', 'timerDigest', 'lockDigest', 'packageDigest', 'bunLockDigest',
      'bunLockbDigest', 'linkTarget', 'runtimeEntry', 'settingsDigest',
    ])
    || !['manifestDigest', 'serviceDigest', 'timerDigest', 'lockDigest', 'settingsDigest']
      .every((name) => /^sha256:[a-f0-9]{64}$/.test(receipt.installed[name] || ''))
    || !['packageDigest', 'bunLockDigest', 'bunLockbDigest'].every((name) => receipt.installed[name] === null
      || /^sha256:[a-f0-9]{64}$/.test(receipt.installed[name] || ''))
    || receipt.installed.linkTarget !== expected.packageRoot
    || !exact(receipt.installed.runtimeEntry, ['version', 'enabledFeatures', 'enabled'])
    || typeof receipt.installed.runtimeEntry.version !== 'string'
    || receipt.installed.runtimeEntry.enabledFeatures !== null
    || receipt.installed.runtimeEntry.enabled !== true) throw new Error('installation receipt is invalid');
  return receipt;
}
