import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createContract, validateContract } from './contract.mjs';
import { guardHealthDiagnostics, guardHealthFailures } from './guard-health.mjs';
import { assertScratchAbsent, cleanupScratch, scratchPaths, validateScratch } from './scratch.mjs';
import { validateExternalEffects, validateQualification, validateRouting } from './policy.mjs';
import { createReceipt, sha256, stableSerialize, verifyReceipt } from './receipt.mjs';
import {
  readState,
  readStateBytes,
  readRecovery,
  readCancellation,
  restoreStateBytes,
  clearRecovery,
  stateDigest,
  validateStatePath,
  withStateLock,
  writeRecovery,
} from './state.mjs';

const MAX_ADMISSION_TO_ACTIVATION_MS = 5_000;
const EXECUTABLE_DIGESTS = new Map();
const ARTIFACT_MAGIC = Buffer.from('OMPART1\n');

function callable(name, value) {
  if (typeof value !== 'function') throw new Error(`${name} must be a function`);
}

function syncPath(target) {
  const descriptor = fs.openSync(target, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function validateExecutable(name, value, hostOwned = false) {
  try {
    const stat = fs.lstatSync(value);
    if (typeof value !== 'string' || !path.isAbsolute(value) || !stat.isFile()
      || stat.isSymbolicLink() || (stat.mode & 0o111) === 0
      || (hostOwned && ((stat.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && stat.uid !== 0)))) throw new Error();
  } catch {
    throw new Error(`${name} must be an absolute executable file`);
  }
}

function validateHostExecutable(name, value, runtimeMounts) {
  validateExecutable(name, value);
  const canonical = fs.realpathSync(value);
  const stat = fs.lstatSync(value);
  const covered = runtimeMounts.some(({ source }) => fs.lstatSync(source).isDirectory()
    && (canonical === source || canonical.startsWith(`${source}${path.sep}`)));
  if (canonical !== value || !covered || (stat.mode & 0o022) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== 65534)) {
    throw new Error(`${name} must be an exact host-owned runtime executable`);
  }
  return capabilityDigest({ command: value, args: [] });
}

function validateCommand(name, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)
    || Object.keys(spec).sort().join(',') !== 'args,command'
    || !Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string')) {
    throw new Error(`${name} must be an exact command spec`);
  }
  validateExecutable(`${name}.command`, spec.command);
}

function validateRuntimeMounts(value, nodePath) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('runtimeMounts must be an exact nonempty mapping');
  const supported = [
    { source: '/usr', target: '/usr' },
    { source: fs.realpathSync('/lib'), target: '/lib' },
    ...(fs.existsSync('/lib64') ? [{ source: fs.realpathSync('/lib64'), target: '/lib64' }] : []),
    ...(fs.existsSync('/etc/ld.so.cache')
      ? [{ source: fs.realpathSync('/etc/ld.so.cache'), target: '/etc/ld.so.cache' }] : []),
  ];
  if (stableSerialize(value) !== stableSerialize(supported)) {
    throw new Error('runtimeMounts exceed the supported FHS runtime capability');
  }
  const targets = new Set();
  for (const entry of value) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'source,target'
      || typeof entry.source !== 'string' || typeof entry.target !== 'string'
      || !path.isAbsolute(entry.source) || !path.isAbsolute(entry.target)
      || path.normalize(entry.target) !== entry.target || targets.has(entry.target)) {
      throw new Error('runtimeMounts must be an exact nonempty mapping');
    }
    let stat;
    try { stat = fs.lstatSync(entry.source); } catch { throw new Error('runtimeMounts source is unavailable'); }
    if (fs.realpathSync(entry.source) !== entry.source || stat.isSymbolicLink()
      || (!stat.isDirectory() && !stat.isFile()) || (stat.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== 65534)) {
      throw new Error('runtimeMounts source is not host-owned read-only data');
    }
    targets.add(entry.target);
  }
}

function commandCoveredByRuntime(name, spec, runtimeMounts, nodePath) {
  const executable = fs.realpathSync(spec.command);
  if (executable !== fs.realpathSync(nodePath)
    && !runtimeMounts.some(({ source }) => fs.lstatSync(source).isDirectory()
    && (executable === source || executable.startsWith(`${source}${path.sep}`)))) {
    throw new Error(`${name} executable is outside qualified runtime mounts`);
  }
  const header = fs.readFileSync(spec.command).subarray(0, 4096);
  if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return;
  if (!header.subarray(0, 2).equals(Buffer.from('#!'))) {
    throw new Error(`${name} executable has no supported binary format or shebang`);
  }
  const interpreter = header.toString('utf8').split('\n', 1)[0].slice(2).trim().split(/\s+/, 1)[0];
  if (!path.isAbsolute(interpreter) || !runtimeMounts.some(({ source, target }) => (
    fs.lstatSync(source).isDirectory()
      ? interpreter === target || interpreter.startsWith(`${target}${path.sep}`)
      : interpreter === target
  ))) {
    throw new Error(`${name} shebang interpreter is outside qualified runtime mounts`);
  }
}

function capabilityDigest(spec) {
  const stat = fs.statSync(spec.command, { bigint: true });
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  let executableDigest = EXECUTABLE_DIGESTS.get(identity);
  if (!executableDigest) {
    executableDigest = sha256(fs.readFileSync(spec.command));
    EXECUTABLE_DIGESTS.set(identity, executableDigest);
  }
  return sha256(stableSerialize({
    command: spec.command,
    args: spec.args,
    executableDigest,
  }));
}

function validateDirectory(name, value, privateOwned = false) {
  try {
    const stat = fs.lstatSync(value);
    if (typeof value !== 'string' || !path.isAbsolute(value) || fs.realpathSync(value) !== value
      || !stat.isDirectory() || stat.isSymbolicLink()
      || (privateOwned && ((stat.mode & 0o022) !== 0
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())))) throw new Error();
  } catch {
    throw new Error(`${name} must be an absolute non-symbolic directory`);
  }
}

function validateEvidenceFile(name, value) {
  try {
    const stat = fs.lstatSync(value);
    if (typeof value !== 'string' || !path.isAbsolute(value) || fs.realpathSync(value) !== value
      || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && ![0, process.getuid()].includes(stat.uid))) throw new Error();
  } catch {
    throw new Error(`${name} must be an immutable qualification file`);
  }
}

function sandboxArgs(spec, stageRoot, readOnly, inputRoot, jobPath, contract, runtimeMounts) {
  const args = [
    '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/nonexistent',
    '--setenv', 'OMP_BOUNDED_JOB', '/job.json',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  ];
  const createdParents = new Set();
  for (const { source, target } of runtimeMounts) {
    const parents = [];
    for (let parent = path.dirname(target); parent !== '/'; parent = path.dirname(parent)) parents.push(parent);
    for (const parent of parents.reverse()) {
      if (!createdParents.has(parent) && !runtimeMounts.some((entry) => entry.target === parent)) {
        args.push('--dir', parent);
        createdParents.add(parent);
      }
    }
    args.push('--ro-bind', source, target);
  }
  args.push('--ro-bind', inputRoot, '/inputs', '--ro-bind', jobPath, '/job.json');
  if (readOnly) {
    args.push('--ro-bind', fs.realpathSync(spec.command), '/runner');
    args.push('--ro-bind', stageRoot, '/work', '--chdir', '/work', '--', '/runner', ...spec.args);
  } else {
    args.push('--ro-bind', fs.realpathSync(spec.command), '/runner');
    args.push('--size', String(contract.budgets.maxArtifactBytes), '--tmpfs', '/work', '--chdir', '/work', '--', '/runner', ...spec.args);
  }
  return args;
}

function artifactReceiver(stageRoot, contract, terminate) {
  const allowed = new Set([...contract.writeScope.paths, ...contract.writeScope.patchPaths]);
  const seen = new Set();
  const maxFiles = contract.writeScope.maxFiles ?? allowed.size;
  const maxBytes = BigInt(contract.budgets.maxArtifactBytes);
  let total = 0n;
  let buffer = Buffer.alloc(0);
  let phase = 'magic';
  let pathBytes = 0;
  let dataBytes = 0n;
  let remaining = 0n;
  let descriptor;
  let failed;
  let artifactExceeded = false;
  let scopeViolation = false;
  const fail = (reason) => {
    if (failed) return;
    failed = reason;
    if (descriptor !== undefined) { fs.closeSync(descriptor); descriptor = undefined; }
    terminate();
  };
  const consume = (chunk) => {
    if (failed || phase === 'done') {
      if (chunk.length) fail('trailing artifact protocol data');
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    while (!failed) {
      if (phase === 'magic') {
        if (buffer.length < ARTIFACT_MAGIC.length) return;
        if (!buffer.subarray(0, ARTIFACT_MAGIC.length).equals(ARTIFACT_MAGIC)) return fail('artifact protocol magic is invalid');
        buffer = buffer.subarray(ARTIFACT_MAGIC.length);
        phase = 'header';
      } else if (phase === 'header') {
        if (buffer.length < 12) return;
        pathBytes = buffer.readUInt32BE(0);
        dataBytes = buffer.readBigUInt64BE(4);
        buffer = buffer.subarray(12);
        if (pathBytes === 0 && dataBytes === 0n) {
          phase = 'done';
          if (buffer.length) fail('trailing artifact protocol data');
          return;
        }
        if (pathBytes < 1 || pathBytes > 4096) return fail('artifact protocol path is invalid');
        phase = 'path';
      } else if (phase === 'path') {
        if (buffer.length < pathBytes) return;
        const encodedPath = buffer.subarray(0, pathBytes);
        const relative = encodedPath.toString('utf8');
        buffer = buffer.subarray(pathBytes);
        if (!Buffer.from(relative).equals(encodedPath) || !allowed.has(relative) || seen.has(relative)) {
          scopeViolation = true;
          return fail('artifact path is duplicate or out of scope');
        }
        if (seen.size + 1 > maxFiles || total + dataBytes > maxBytes || dataBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
          artifactExceeded = true;
          return fail('artifact quota exceeded');
        }
        seen.add(relative);
        total += dataBytes;
        remaining = dataBytes;
        const target = confinedTarget(stageRoot, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        descriptor = fs.openSync(target, 'wx', 0o600);
        phase = 'data';
      } else if (phase === 'data') {
        if (remaining === 0n) {
          fs.fsyncSync(descriptor);
          fs.closeSync(descriptor);
          descriptor = undefined;
          phase = 'header';
          continue;
        }
        if (buffer.length === 0) return;
        const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
        fs.writeSync(descriptor, buffer, 0, length);
        buffer = buffer.subarray(length);
        remaining -= BigInt(length);
      } else return;
    }
  };
  return {
    consume,
    finish: () => {
      if (!failed && phase !== 'done') fail('artifact protocol is truncated');
      return { valid: !failed && phase === 'done', artifactExceeded, scopeViolation, error: failed, total: Number(total) };
    },
  };
}

function executeSandboxed({
  spec, stageRoot, readOnly, contract, deadline, clock, bwrapPath, prlimitPath, inputRoot, jobPath,
  runtimeMounts, readBytes = 0, signal, onSpawn,
}) {
  const remaining = Date.parse(deadline) - Date.parse(clock());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('sandbox deadline expired');
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('bounded run aborted');
  const maxOutput = contract.budgets.maxOutputBytes;
  const limits = [
    `--cpu=${Math.max(1, Math.min(60, Math.ceil(remaining / 1000)))}`,
    '--as=2147483648', '--nproc=1536', `--fsize=${contract.budgets.maxArtifactBytes}`,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(prlimitPath, [...limits, '--', bwrapPath,
      ...sandboxArgs(spec, stageRoot, readOnly, inputRoot, jobPath, contract, runtimeMounts)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    try { onSpawn?.(child.pid); }
    catch (error) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      reject(error);
      return;
    }
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const terminate = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const receiver = readOnly ? null : artifactReceiver(stageRoot, contract, terminate);
    const collect = (chunk) => {
      const room = maxOutput - bytes;
      if (room > 0) chunks.push(chunk.subarray(0, room));
      bytes += chunk.length;
      if (bytes > maxOutput) {
        truncated = true;
        terminate();
      }
    };
    const timer = setTimeout(terminate, remaining);
    if (readOnly) child.stdout.on('data', collect);
    else child.stdout.on('data', receiver.consume);
    child.stderr.on('data', collect);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('bounded run aborted'));
        return;
      }
      resolve({ status: 'failed', sandboxed: false, output: '', usage: {} });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('bounded run aborted'));
        return;
      }
      const artifacts = receiver?.finish();
      resolve({
        status: code === 0 && !truncated && (readOnly || artifacts?.valid) ? 'completed' : 'failed',
        sandboxed: true,
        output: Buffer.concat(chunks).toString('utf8'),
        truncated,
        artifactExceeded: artifacts?.artifactExceeded === true,
        scopeViolation: artifacts?.scopeViolation === true,
        protocolError: artifacts?.error,
        usage: {
          requests: 1,
          workers: readOnly ? 0 : 1,
          readBytes: readOnly ? stageBytes(stageRoot) : readBytes,
          artifactBytes: readOnly ? 0 : stageBytes(stageRoot),
          outputBytes: Math.min(bytes, contract.budgets.maxOutputBytes),
        },
      });
    });
  });
}

function stageBytes(root) {
  let total = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  }
  visit(root);
  return total;
}

function parseVerification(run) {
  if (run.status !== 'completed' || run.truncated) return null;
  try {
    const report = JSON.parse(run.output);
    if (!report || typeof report !== 'object' || Array.isArray(report)
      || Object.keys(report).sort().join(',') !== 'artifactDigest,contractDigest,findings,objectives,passed,schema,verdict') return null;
    return {
      schema: report.schema,
      passed: report.passed,
      contractDigest: report.contractDigest,
      artifactDigest: report.artifactDigest,
      verdict: report.verdict,
      findings: report.findings,
      objectives: report.objectives,
      readOnly: true,
      digest: sha256(run.output),
    };
  } catch {
    return null;
  }
}

function confinedTarget(root, relative) {
  const target = path.join(root, ...relative.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('delivery path escaped root');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('delivery path contains a symlink');
  }
  return target;
}

function validateDeliveryParents(root, relative) {
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('delivery parent directory has unsafe permissions');
    }
  }
}

function removeDeliveryDirectories(root, directories) {
  for (const relative of [...directories].reverse()) {
    const directory = confinedTarget(root, relative);
    try { fs.rmdirSync(directory); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error('delivery cleanup incomplete', { cause: error });
    }
    syncPath(path.dirname(directory));
  }
}

function removeDeliveryTransaction(root, transaction) {
  try { fs.rmSync(transaction, { recursive: true }); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('delivery cleanup incomplete', { cause: error });
  }
  syncPath(root);
}

function recoverDelivery(root, recovery, statePath) {
  if (!recovery?.delivery) return;
  const delivery = recovery.delivery;
  if (delivery.root !== root || typeof delivery.transaction !== 'string'
    || !/^\.omp-run-[A-Za-z0-9_-]+$/.test(delivery.transaction)
    || !Array.isArray(delivery.items) || delivery.items.length === 0) {
    throw new Error('delivery recovery record is invalid');
  }
  const transaction = confinedTarget(root, delivery.transaction);
  if (delivery.phase === 'committed-cleanup') {
    if (fs.existsSync(transaction)
      && (!fs.lstatSync(transaction).isDirectory() || fs.lstatSync(transaction).isSymbolicLink())) {
      throw new Error('delivery recovery transaction is invalid');
    }
    removeDeliveryTransaction(root, transaction);
    if (recovery.scratch) cleanupScratch(recovery.scratch, recovery.pending.runId, path.join(root, 'receipts'));
    return;
  }
  if (!fs.existsSync(transaction)) {
    if (delivery.phase === 'preparing'
      || delivery.items.every((item) => !item.installing && !item.installed)) {
      removeDeliveryDirectories(root, delivery.directories);
      syncPath(root);
      if (recovery.scratch) cleanupScratch(recovery.scratch, recovery.pending.runId, path.join(root, 'receipts'));
      return;
    }
    throw new Error('delivery recovery transaction is invalid');
  }
  if (!fs.lstatSync(transaction).isDirectory() || fs.lstatSync(transaction).isSymbolicLink()) {
    throw new Error('delivery recovery transaction is invalid');
  }
  for (const item of [...delivery.items].reverse()) {
    if (!item || typeof item.relative !== 'string' || typeof item.backup !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(item.backup)) throw new Error('delivery recovery item is invalid');
    const target = confinedTarget(root, item.relative);
    const backup = confinedTarget(transaction, item.backup);
    const backupExists = fs.existsSync(backup);
    const targetExists = fs.existsSync(target);
    if (!item.installed && !(item.installing && (backupExists || (!item.hadOriginal && targetExists)))) continue;
    if (item.hadOriginal) {
      if (!backupExists || !fs.lstatSync(backup).isFile() || fs.lstatSync(backup).isSymbolicLink()) {
        throw new Error('delivery recovery backup is invalid');
      }
      if (targetExists) {
        if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) {
          throw new Error('delivery recovery target is invalid');
        }
        fs.rmSync(target);
      }
      fs.renameSync(backup, target);
      syncPath(path.dirname(target));
      syncPath(transaction);
    } else if ((item.installing || item.installed) && targetExists) {
      if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) {
        throw new Error('delivery recovery target is invalid');
      }
      fs.rmSync(target);
      syncPath(path.dirname(target));
    }
    item.installing = false;
    item.installed = false;
    writeRecovery(statePath, recovery);
  }
  removeDeliveryDirectories(root, delivery.directories);
  removeDeliveryTransaction(root, transaction);
  if (recovery.scratch) cleanupScratch(recovery.scratch, recovery.pending.runId, path.join(root, 'receipts'));
}

function transactionallyDeliver(root, stageRoot, contract, receipt, statePath, baseline) {
  const scratch = scratchPaths(path.join(root, 'receipts'), contract.runId);
  validateScratch(scratch, contract.runId, path.join(root, 'receipts'));
  const outputs = contract.delivery.outputPaths.map((relative) => ({ relative, source: confinedTarget(stageRoot, relative) }));
  const items = [...outputs, {
    relative: contract.delivery.receiptPath,
    content: `${JSON.stringify(receipt, null, 2)}\n`,
  }];
  const transaction = path.join(root, `.omp-run-${contract.runId.slice(4)}-${Math.random().toString(16).slice(2)}`);
  const prepared = items.map((item, index) => {
    const target = confinedTarget(root, item.relative);
    validateDeliveryParents(root, item.relative);
    if (fs.existsSync(target)) {
      const metadata = fs.lstatSync(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error('delivery target is not a regular file');
      }
    }
    return {
      target,
      candidate: path.join(transaction, `new-${index}`),
      backup: path.join(transaction, `old-${index}`),
      hadOriginal: fs.existsSync(target),
      installing: false,
      installed: false,
    };
  });
  const createdDirectories = [...new Set(prepared.flatMap(({ target }) => {
    const missing = [];
    for (let directory = path.dirname(target); directory !== root && !fs.existsSync(directory); directory = path.dirname(directory)) {
      missing.push(directory);
    }
    return missing;
  }))].sort((left, right) => left.length - right.length);
  let journalStarted = false;
  const recovery = {
    schema: 'omp-bounded-recovery/v1',
    pending: { runId: contract.runId, baseline, reason: 'delivery' },
    active: null,
    delivery: {
      root,
      transaction: path.basename(transaction),
      phase: 'preparing',
      directories: createdDirectories.map((directory) => path.relative(root, directory)),
      items: prepared.map((item, index) => ({
        relative: items[index].relative,
        backup: path.basename(item.backup),
        hadOriginal: item.hadOriginal,
        installing: false,
        installed: false,
      })),
    },
    scratch,
  };
  let committed = false;
  try {
    writeRecovery(statePath, recovery);
    journalStarted = true;
    fs.mkdirSync(transaction, { mode: 0o700 });
    syncPath(root);
    for (const [index, item] of items.entries()) {
      const candidate = prepared[index].candidate;
      if (item.source) fs.copyFileSync(item.source, candidate, fs.constants.COPYFILE_EXCL);
      else fs.writeFileSync(candidate, item.content, { flag: 'wx', mode: 0o600 });
      syncPath(candidate);
      if (item.source) {
        const artifact = receipt.artifacts.find(({ path: artifactPath }) => artifactPath === item.relative);
        if (!artifact || sha256(fs.readFileSync(candidate)) !== artifact.digest) throw new Error('delivery candidate digest mismatch');
      } else if (!verifyReceipt(JSON.parse(fs.readFileSync(candidate, 'utf8')), contract).valid) {
        throw new Error('delivery receipt self-verification failed');
      }
    }
    for (const directory of createdDirectories) {
      fs.mkdirSync(directory, { mode: 0o700 });
      syncPath(path.dirname(directory));
    }
    recovery.delivery.phase = 'prepared';
    writeRecovery(statePath, recovery);
    for (const [index, item] of prepared.entries()) {
      item.installing = true;
      recovery.delivery.items[index].installing = true;
      writeRecovery(statePath, recovery);
      if (item.hadOriginal) fs.renameSync(item.target, item.backup);
      fs.renameSync(item.candidate, item.target);
      syncPath(path.dirname(item.target));
      syncPath(transaction);
      item.installed = true;
      recovery.delivery.items[index].installed = true;
      writeRecovery(statePath, recovery);
    }
    for (const artifact of receipt.artifacts) {
      if (sha256(fs.readFileSync(confinedTarget(root, artifact.path))) !== artifact.digest) {
        throw new Error('delivered artifact digest mismatch');
      }
    }
    if (!verifyReceipt(JSON.parse(fs.readFileSync(confinedTarget(root, contract.delivery.receiptPath), 'utf8')), contract).valid) {
      throw new Error('delivered receipt verification failed');
    }
    recovery.delivery.phase = 'committed-cleanup';
    writeRecovery(statePath, recovery);
    committed = true;
    removeDeliveryTransaction(root, transaction);
    clearRecovery(statePath);
  } catch (error) {
    if (committed) throw error;
    let rollbackError;
    try {
      for (let index = prepared.length - 1; index >= 0; index -= 1) {
        const item = prepared[index];
        if (item.hadOriginal && fs.existsSync(item.backup)) {
          fs.rmSync(item.target, { force: true });
          fs.renameSync(item.backup, item.target);
          syncPath(path.dirname(item.target));
          syncPath(transaction);
        } else if ((item.installing || item.installed) && fs.existsSync(item.target)) {
          fs.rmSync(item.target);
          syncPath(path.dirname(item.target));
        }
        if (journalStarted) {
          recovery.delivery.items[index].installing = false;
          recovery.delivery.items[index].installed = false;
          writeRecovery(statePath, recovery);
        }
      }
      removeDeliveryDirectories(root, recovery.delivery.directories);
      if (journalStarted) {
        removeDeliveryTransaction(root, transaction);
        clearRecovery(statePath);
      }
    } catch (rollbackFailure) { rollbackError = rollbackFailure; }
    if (rollbackError) throw new AggregateError([error, rollbackError], 'delivery failed and recovery remains pending');
    throw error;
  } finally {
    if (!journalStarted) {
      fs.rmSync(transaction, { recursive: true, force: true });
      syncPath(root);
    }
  }
}

export function createController({
  statePath,
  deliveryRoot,
  inputRoot,
  qualificationPaths,
  clock,
  worker,
  verifierCommand,
  guard,
  bwrapPath,
  prlimitPath,
  flockPath,
  nodePath,
  runtimeMounts,
  executor,
  verifier,
} = {}) {
  if (executor || verifier) throw new Error('ambient executor functions are forbidden; command specs are required');
  validateStatePath(statePath);
  callable('clock', clock);
  validateDirectory('deliveryRoot', deliveryRoot, true);
  const receiptRoot = path.join(deliveryRoot, 'receipts');
  validateDirectory('deliveryRoot receipts', receiptRoot, true);
  validateDirectory('inputRoot', inputRoot, true);
  const deliveryPrefix = `${fs.realpathSync(deliveryRoot)}${path.sep}`;
  const inputPrefix = `${fs.realpathSync(inputRoot)}${path.sep}`;
  if (fs.realpathSync(inputRoot) === fs.realpathSync(deliveryRoot)
    || fs.realpathSync(statePath).startsWith(deliveryPrefix)
    || fs.realpathSync(statePath).startsWith(inputPrefix)
    || fs.realpathSync(inputRoot).startsWith(deliveryPrefix)
    || fs.realpathSync(deliveryRoot).startsWith(inputPrefix)) {
    throw new Error('state, input, and delivery roots must be separate host boundaries');
  }
  if (!qualificationPaths || typeof qualificationPaths !== 'object' || Array.isArray(qualificationPaths)
    || Object.keys(qualificationPaths).sort().join(',') !== 'capabilities,config,node,probe,review,sources,suite'
    || !qualificationPaths.sources || typeof qualificationPaths.sources !== 'object'
    || Array.isArray(qualificationPaths.sources) || Object.keys(qualificationPaths.sources).length === 0) {
    throw new Error('qualificationPaths must be exact constructor-owned evidence paths');
  }
  for (const [name, value] of Object.entries(qualificationPaths.sources)) {
    validateEvidenceFile(`qualificationPaths.sources.${name}`, value);
    if (fs.realpathSync(value).startsWith(deliveryPrefix) || fs.realpathSync(value).startsWith(inputPrefix)) {
      throw new Error('qualification evidence must be outside untrusted roots');
    }
  }
  for (const name of ['config', 'suite', 'review', 'capabilities', 'probe', 'node']) {
    validateEvidenceFile(`qualificationPaths.${name}`, qualificationPaths[name]);
    if (fs.realpathSync(qualificationPaths[name]).startsWith(deliveryPrefix)
      || fs.realpathSync(qualificationPaths[name]).startsWith(inputPrefix)) {
      throw new Error('qualification evidence must be outside untrusted roots');
    }
  }
  validateCommand('worker', worker);
  validateCommand('verifierCommand', verifierCommand);
  validateExecutable('nodePath', nodePath);
  validateRuntimeMounts(runtimeMounts, nodePath);
  commandCoveredByRuntime('worker', worker, runtimeMounts, nodePath);
  commandCoveredByRuntime('verifierCommand', verifierCommand, runtimeMounts, nodePath);
  const hostExecutables = { bwrapPath, prlimitPath, flockPath };
  const hostCapabilityDigests = Object.fromEntries(Object.entries(hostExecutables)
    .map(([name, value]) => [name, validateHostExecutable(name, value, runtimeMounts)]));
  if (stableSerialize(worker) === stableSerialize(verifierCommand)) throw new Error('worker and verifier must be independent');
  let nodeRecord;
  try { nodeRecord = JSON.parse(fs.readFileSync(qualificationPaths.node, 'utf8')); } catch {}
  const qualifiedNodeDigest = capabilityDigest({ command: nodePath, args: [] });
  if (!nodeRecord || Object.keys(nodeRecord).sort().join(',') !== 'nodeDigest,nodePath,schema'
    || nodeRecord.schema !== 'omp-node-qualification/v1' || nodeRecord.nodePath !== nodePath
    || nodeRecord.nodeDigest !== qualifiedNodeDigest) {
    throw new Error('nodePath is not bound by host qualification');
  }
  for (const name of ['status', 'activate', 'rollback', 'verifyRollback']) callable(`guard.${name}`, guard?.[name]);

  const admitted = new Map();

  function assertRuntimeCapabilities() {
    if (capabilityDigest({ command: nodePath, args: [] }) !== qualifiedNodeDigest) {
      throw new Error('qualified nodePath drifted');
    }
    for (const [name, value] of Object.entries(hostExecutables)) {
      if (validateHostExecutable(name, value, runtimeMounts) !== hostCapabilityDigests[name]) {
        throw new Error(`qualified ${name} drifted`);
      }
    }
  }

  function qualificationEvidence(state = readState(statePath)) {
    validateRuntimeMounts(runtimeMounts, nodePath);
    const sourceDigests = Object.fromEntries(Object.entries(qualificationPaths.sources)
      .map(([name, file]) => [name, sha256(fs.readFileSync(file))]));
    const configDigest = sha256(fs.readFileSync(qualificationPaths.config));
    const scopeDigest = state.qualification.scopeDigest;
    let suite;
    let review;
    let capabilities;
    let probe;
    try {
      suite = JSON.parse(fs.readFileSync(qualificationPaths.suite, 'utf8'));
      review = JSON.parse(fs.readFileSync(qualificationPaths.review, 'utf8'));
      capabilities = JSON.parse(fs.readFileSync(qualificationPaths.capabilities, 'utf8'));
      probe = JSON.parse(fs.readFileSync(qualificationPaths.probe, 'utf8'));
    } catch { throw new Error('qualification evidence is malformed'); }
    const runtimeMountsDigest = sha256(stableSerialize(runtimeMounts));
    const nodeDigest = capabilityDigest({ command: nodePath, args: [] });
    const probeDigest = sha256(fs.readFileSync(qualificationPaths.probe));
    const subjectDigest = sha256(stableSerialize({
      sourceDigests,
      configDigest,
      runtimeMountsDigest,
      workerCapability: capabilities?.worker,
      verifierCapability: capabilities?.verifier,
      nodeDigest,
      probeDigest,
    }));
    const contractDigest = sha256(stableSerialize({ subjectDigest, scopeDigest }));
    if (Object.keys(suite || {}).sort().join(',') !== 'contractDigest,passed,schema,scopeDigest,subjectDigest'
      || suite.schema !== 'omp-qualification-suite/v1' || suite.passed !== true
      || suite.subjectDigest !== subjectDigest || suite.scopeDigest !== scopeDigest
      || suite.contractDigest !== contractDigest
      || Object.keys(review || {}).sort().join(',') !== 'contractDigest,findings,reviewerFamily,schema,scopeDigest,subjectDigest,verdict'
      || review.schema !== 'omp-qualification-review/v1' || review.verdict !== 'CLEAN'
      || !Array.isArray(review.findings) || review.findings.length !== 0
      || review.subjectDigest !== subjectDigest || review.scopeDigest !== scopeDigest
      || review.contractDigest !== contractDigest || review.reviewerFamily !== state.routing.reviewerFamily
      || Object.keys(capabilities || {}).sort().join(',') !== 'runtimeMountsDigest,schema,verifier,worker'
      || capabilities.schema !== 'omp-capability-qualification/v1'
      || capabilities.runtimeMountsDigest !== sha256(stableSerialize(runtimeMounts))
      || Object.keys(capabilities.worker || {}).sort().join(',') !== 'digest,family'
      || Object.keys(capabilities.verifier || {}).sort().join(',') !== 'digest,family'
      || capabilities.worker.digest !== capabilityDigest(worker)
      || capabilities.verifier.digest !== capabilityDigest(verifierCommand)
      || capabilities.worker.family !== state.routing.chains.find(({ role }) => role === 'task')?.family
      || capabilities.verifier.family !== state.routing.reviewerFamily
      || Object.keys(probe || {}).sort().join(',') !== 'nodeDigest,passed,runtimeMountsDigest,schema,verifierCapability,workerCapability'
      || probe.schema !== 'omp-sandbox-capability-probe/v1' || probe.passed !== true
      || stableSerialize(probe.workerCapability) !== stableSerialize(capabilities.worker)
      || stableSerialize(probe.verifierCapability) !== stableSerialize(capabilities.verifier)
      || probe.nodeDigest !== nodeDigest || probe.runtimeMountsDigest !== runtimeMountsDigest) {
      throw new Error('qualification suite or review evidence is invalid');
    }
    return {
      sourceDigests,
      configDigest,
      suiteDigest: sha256(fs.readFileSync(qualificationPaths.suite)),
      reviewDigest: sha256(fs.readFileSync(qualificationPaths.review)),
      probeDigest,
      runtimeMountsDigest,
      workerCapability: structuredClone(capabilities.worker),
      verifierCapability: structuredClone(capabilities.verifier),
      nodeDigest,
    };
  }

  function qualificationScopeDigest(contract, state = readState(statePath)) {
    const qualified = state.qualification;
    return sha256(stableSerialize({
      boundedContext: contract.boundedContext,
      writeScope: contract.writeScope,
      delivery: { mode: contract.delivery.mode, outputPaths: contract.delivery.outputPaths },
      budgets: contract.budgets,
      acceptance: {
        acceptanceCheck: contract.acceptanceCheck,
        requiredGates: contract.requiredGates,
        retries: contract.retries,
        stopPolicy: contract.stopPolicy,
        externalEffects: { enabled: false, finalGate: 'human-approval' },
        prohibitedEffects: 'all external effects',
        maxSeconds: (Date.parse(contract.expiresAt) - Date.parse(contract.createdAt)) / 1000,
        phase: contract.phase,
        allowFallback: contract.allowFallback,
      },
      configDigest: qualified.configDigest,
      runtimeMountsDigest: qualified.runtimeMountsDigest,
      workerCapability: qualified.workerCapability,
      verifierCapability: qualified.verifierCapability,
      nodeDigest: qualified.nodeDigest,
      probeDigest: qualified.probeDigest,
      sourceDigests: qualified.sourceDigests,
    }));
  }

  function snapshotInputs(request, contract) {
    const entries = [];
    let readBytes = 0;
    const inputPaths = [contract.boundedContext.sessionPath, ...contract.boundedContext.readPaths];
    if (new Set(inputPaths).size !== inputPaths.length) throw new Error('bounded inputs must be distinct');
    for (const relative of inputPaths) {
      const target = confinedTarget(inputRoot, relative);
      const metadata = fs.existsSync(target) ? fs.lstatSync(target) : null;
      if (!metadata || !metadata.isFile() || metadata.isSymbolicLink() || fs.realpathSync(target) !== target
        || (metadata.mode & 0o022) !== 0
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error('bounded input is missing or unsafe');
      }
      const content = fs.readFileSync(target);
      readBytes += content.length;
      entries.push({ path: relative, bytes: content.length, digest: sha256(content), content: content.toString('base64') });
    }
    if (readBytes > contract.boundedContext.maxBytes || readBytes > contract.budgets.maxReadBytes) {
      throw new Error('bounded input exceeds read budget');
    }
    return Object.freeze({
      schema: 'omp-bounded-job/v1',
      runId: contract.runId,
      contractDigest: sha256(stableSerialize(contract)),
      trigger: Object.freeze({ id: request.trigger.id, value: request.trigger.value, digest: contract.trigger.digest }),
      task: Object.freeze({ id: request.task.id, value: request.task.value, digest: contract.task.digest }),
      acceptanceCheck: Object.freeze({
        id: request.acceptanceCheck.id, value: request.acceptanceCheck.value, digest: contract.acceptanceCheck.digest,
      }),
      contract: structuredClone(contract),
      policy: Object.freeze({
        allowFallback: false,
        externalEffects: Object.freeze({ enabled: false, finalGate: 'human-approval' }),
      }),
      boundedContext: Object.freeze({
        sessionPath: contract.boundedContext.sessionPath,
        readPaths: Object.freeze([...contract.boundedContext.readPaths]),
        readBytes,
        inputs: Object.freeze(entries.map(({ content, ...entry }) => Object.freeze(entry))),
      }),
      snapshots: entries,
    });
  }

  async function restore(reason) {
    let recovery;
    try { recovery = readRecovery(statePath); }
    catch (error) {
      await guard.rollback(reason, { lockHeld: true });
      if (await guard.verifyRollback() !== true) throw new Error('rollback verification failed');
      throw error;
    }
    if (recovery?.pending?.reason === 'delivery') {
      recoverDelivery(deliveryRoot, recovery, statePath);
      restoreStateBytes(statePath, recovery.pending.baseline);
      clearRecovery(statePath);
      await guard.rollback(reason, { lockHeld: true });
    } else {
      await guard.rollback(reason, { lockHeld: true });
      recovery = readRecovery(statePath);
      if (recovery?.pending?.baseline) restoreStateBytes(statePath, recovery.pending.baseline);
      else {
      try { readState(statePath); }
      catch (error) {
        if (await guard.verifyRollback() !== true) throw new Error('rollback verification failed');
        throw error;
      }
      }
    }
    clearRecovery(statePath);
    const protectedState = readState(statePath);
    if (protectedState.level !== 'L3-narrow-write'
      || protectedState.killSwitch?.active !== true
      || protectedState.killSwitch.marker !== 'UNATTENDED_MODE_DISABLED'
      || readRecovery(statePath)
      || await guard.verifyRollback() !== true) throw new Error('rollback verification failed');
    return { status: 'protected', reason };
  }

  function validateCurrentQualification(contract, current) {
    validateQualification(current, {
      now: clock(), taskDigest: contract.task.digest,
      scopeDigest: qualificationScopeDigest(contract, current), evidence: qualificationEvidence(current),
    });
    if (stateDigest(current) !== contract.trustedStateDigest
      || stableSerialize(current.routing) !== stableSerialize(contract.routing)
      || current.qualification.workerCapability.digest !== capabilityDigest(worker)
      || current.qualification.verifierCapability.digest !== capabilityDigest(verifierCommand)
      || current.qualification.nodeDigest !== capabilityDigest({ command: nodePath, args: [] })) {
      throw new Error('qualified state drifted');
    }
  }

  async function preflight(contract, state) {
    validateCurrentQualification(contract, state);
    if (Date.parse(clock()) - Date.parse(contract.createdAt) > MAX_ADMISSION_TO_ACTIVATION_MS) {
      throw new Error('activation window did not start immediately after admission');
    }
    if (Date.parse(clock()) >= Date.parse(contract.expiresAt)) throw new Error('contract expired before activation');
    const report = await guard.status();
    const failures = [
      ...guardHealthFailures(report),
      ...(report.killSwitchActive !== true ? ['kill switch is not active'] : []),
      ...(report.routingReady !== true ? ['routing is not ready'] : []),
      ...(report.providersReady !== true ? ['providers are not ready'] : []),
      ...(report.digestsReady !== true ? ['qualified digests are not ready'] : []),
      ...(report.drift === true ? ['guard drift detected'] : []),
    ];
    if (failures.length) {
      throw new Error(`live preflight failed: ${failures.join('; ')} ${JSON.stringify(guardHealthDiagnostics(report))}`);
    }
    validateCurrentQualification(contract, readState(statePath));
    if (Date.parse(clock()) - Date.parse(contract.createdAt) > MAX_ADMISSION_TO_ACTIVATION_MS) {
      throw new Error('activation window did not start immediately after admission');
    }
  }

  function inspectStage(contract, stageRoot) {
    const files = [];
    function visit(directory, prefix = '') {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('staged artifact escaped write scope');
        if (entry.isDirectory()) visit(full, relative);
        else if (entry.isFile()) {
          const content = fs.readFileSync(full);
          files.push({ path: relative, bytes: content.length, digest: sha256(content) });
        } else throw new Error('unsupported staged artifact');
      }
    }
    visit(stageRoot);
    const allowed = new Set([...contract.writeScope.paths, ...contract.writeScope.patchPaths]);
    if (files.length !== allowed.size || files.some((file) => !allowed.has(file.path))) {
      throw new Error('staged artifacts violate write scope');
    }
    return files;
  }

  function validateExecution(contract, execution, stageRoot) {
    if (execution?.artifactExceeded) throw new Error('artifact quota exceeded during sandboxed execution');
    if (execution?.scopeViolation) throw new Error('staged artifacts violate write scope');
    if (execution?.status !== 'completed' || execution.sandboxed !== true) throw new Error('sandboxed execution failed');
    const artifacts = inspectStage(contract, stageRoot);
    const artifactBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
    const usage = execution.usage;
    const limits = {
      requests: contract.budgets.maxRequests,
      workers: contract.budgets.maxWorkers,
      readBytes: contract.budgets.maxReadBytes,
      artifactBytes: contract.budgets.maxArtifactBytes,
      outputBytes: contract.budgets.maxOutputBytes,
    };
    if (!usage || Object.keys(usage).sort().join(',') !== Object.keys(limits).sort().join(',')
      || Object.entries(limits).some(([key, maximum]) => (
        !Number.isInteger(usage[key]) || usage[key] < 0 || usage[key] > maximum
      ))) throw new Error('execution quota exceeded');
    if (artifactBytes !== usage.artifactBytes || artifactBytes > contract.budgets.maxArtifactBytes) {
      throw new Error('artifact quota or write scope violated');
    }
    return { ...execution, writePaths: artifacts.map(({ path: artifactPath }) => artifactPath), artifacts };
  }

  function validateVerification(contract, verification, expected) {
    if (verification?.schema !== 'omp-independent-verification/v1'
      || verification.passed !== true || verification.readOnly !== true
      || !/^sha256:[a-f0-9]{64}$/.test(verification.digest || '')
      || verification.contractDigest !== expected.contractDigest
      || verification.artifactDigest !== expected.artifactDigest
      || verification.verifierFamily !== contract.routing.reviewerFamily
      || verification.verdict !== 'CLEAN'
      || !Array.isArray(verification.findings) || verification.findings.length !== 0
      || !verification.objectives || typeof verification.objectives !== 'object'
      || Array.isArray(verification.objectives)
      || Object.keys(verification.objectives).sort().join(',') !== [...contract.delivery.outputPaths].sort().join(',')
      || !contract.delivery.outputPaths.every((item) => verification.objectives[item] === true)
      || Object.values(verification.objectives).some((value) => value !== true)) {
      throw new Error('independent verification failed');
    }
  }

  const controller = {
    async admit(request) {
      const state = readState(statePath);
      validateExternalEffects(request?.externalEffects, request?.prohibitedEffects);
      validateRouting(request, state);
      if (state.level !== 'L3-narrow-write' || state.killSwitch?.active !== true
        || state.killSwitch.marker !== 'UNATTENDED_MODE_DISABLED' || readRecovery(statePath)) {
        throw new Error('bounded admission requires an idle protected L3 state');
      }
      const trustedStateDigest = stateDigest(state);
      const contract = createContract(request, { now: clock(), trustedStateDigest });
      validateQualification(state, {
        now: clock(), taskDigest: contract.task.digest,
        scopeDigest: qualificationScopeDigest(contract, state), evidence: qualificationEvidence(state),
      });
      if (state.qualification.workerCapability.digest !== capabilityDigest(worker)
        || state.qualification.verifierCapability.digest !== capabilityDigest(verifierCommand)
        || request.verifier.digest !== capabilityDigest(verifierCommand)) {
        throw new Error('qualified execution capability drifted');
      }
      admitted.set(contract.runId, {
        digest: sha256(stableSerialize(contract)),
        job: snapshotInputs(request, contract),
      });
      return contract;
    },

    async discard(contract) {
      const runId = contract?.runId;
      if (typeof runId !== 'string' || !runId) throw new Error('admitted contract is required');
      const admission = admitted.get(runId);
      if (!admission) return { status: 'absent', runId };
      if (admission.digest !== sha256(stableSerialize(contract))) throw new Error('admitted contract digest differs');
      admitted.delete(runId);
      return { status: 'discarded', runId };
    },

    async run(contract, { signal } = {}) {
      const digest = sha256(stableSerialize(contract));
      const admission = admitted.get(contract?.runId);
      if (admission?.digest !== digest) throw new Error('contract was not admitted by this controller or was already consumed');
      if (!validateContract(contract, { now: clock() }).valid) throw new Error('admitted contract is stale or invalid');
      admitted.delete(contract.runId);
      assertRuntimeCapabilities();
      return withStateLock(statePath, flockPath, nodePath, async () => {
        const assertNotCancelled = () => {
          if (readCancellation(statePath)?.runId === contract.runId) {
            throw new Error('bounded execution expired');
          }
        };
        const receiptTarget = path.join(receiptRoot, `${contract.runId}.json`);
        if (fs.existsSync(receiptTarget) && fs.lstatSync(receiptTarget).isFile()) throw new Error('receipt already exists');
        const baseline = readStateBytes(statePath);
        let stageRoot;
        let jobRoot;
        try {
          const state = readState(statePath);
          await preflight(contract, state);
          const scratch = scratchPaths(receiptRoot, contract.runId);
          validateScratch(scratch, contract.runId, receiptRoot);
          assertScratchAbsent(scratch);
          writeRecovery(statePath, {
            schema: 'omp-bounded-recovery/v1',
            pending: { runId: contract.runId, baseline, reason: 'activation' },
            active: null,
            scratch,
          });
          const activationDuration = Date.parse(contract.expiresAt) - Date.parse(contract.createdAt);
          const activatedAt = clock();
          if (Date.parse(activatedAt) - Date.parse(contract.createdAt) > MAX_ADMISSION_TO_ACTIVATION_MS) {
            throw new Error('activation window did not start immediately after admission');
          }
          const activationExpiresAt = new Date(Date.parse(activatedAt) + activationDuration).toISOString();
          const activationContract = Object.freeze({
            ...contract,
            createdAt: activatedAt,
            deadline: activationExpiresAt,
            expiresAt: activationExpiresAt,
          });
          await guard.activate(activationContract);
          assertNotCancelled();
          validateCurrentQualification(contract, readState(statePath));
          const pending = readRecovery(statePath);
          writeRecovery(statePath, {
            ...pending,
            active: {
              runId: contract.runId,
              activatedAt,
              expiresAt: activationExpiresAt,
              contractDigest: digest,
              taskDigest: contract.task.digest,
              scopeDigest: qualificationScopeDigest(contract),
            },
          });
          const boundScratch = readRecovery(statePath).scratch;
          const stagePath = path.join(boundScratch.root, boundScratch.stage);
          const jobPathRoot = path.join(boundScratch.root, boundScratch.job);
          fs.mkdirSync(stagePath, { mode: 0o700 });
          stageRoot = stagePath;
          fs.mkdirSync(jobPathRoot, { mode: 0o700 });
          jobRoot = jobPathRoot;
          const snapshotRoot = path.join(jobRoot, 'inputs');
          fs.mkdirSync(snapshotRoot, { mode: 0o700 });
          for (const input of admission.job.snapshots) {
            const target = confinedTarget(snapshotRoot, input.path);
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            fs.writeFileSync(target, Buffer.from(input.content, 'base64'), { flag: 'wx', mode: 0o400 });
          }
          const jobPath = path.join(jobRoot, 'job.json');
          const { snapshots, ...publicJob } = admission.job;
          fs.writeFileSync(jobPath, `${JSON.stringify(publicJob)}\n`, { flag: 'wx', mode: 0o400 });
          const execution = await executeSandboxed({
            spec: worker,
            stageRoot,
            readOnly: false,
            contract,
            deadline: activationExpiresAt,
            clock,
            bwrapPath,
            prlimitPath,
            inputRoot: snapshotRoot,
            jobPath,
            runtimeMounts,
            readBytes: admission.job.boundedContext.readBytes,
            signal,
            onSpawn: (pid) => {
              guard.bindProcess?.(contract.runId, pid);
              assertNotCancelled();
            },
          });
          assertNotCancelled();
          const normalizedExecution = validateExecution(contract, execution, stageRoot);
          validateCurrentQualification(contract, readState(statePath));
          if (Date.parse(clock()) >= Date.parse(activationExpiresAt)) throw new Error('bounded execution expired');
          const verificationJob = {
            schema: 'omp-verification-job/v1',
            runId: contract.runId,
            contractDigest: digest,
            artifactDigest: sha256(stableSerialize(normalizedExecution.artifacts)),
            task: admission.job.task,
            acceptanceCheck: admission.job.acceptanceCheck,
            contract,
            policy: admission.job.policy,
            outputPaths: [...contract.delivery.outputPaths],
          };
          const verificationJobPath = path.join(jobRoot, 'verification.json');
          fs.writeFileSync(verificationJobPath, `${JSON.stringify(verificationJob)}\n`, { flag: 'wx', mode: 0o400 });
          const verificationRun = await executeSandboxed({
            spec: verifierCommand,
            stageRoot,
            readOnly: true,
            contract,
            deadline: activationExpiresAt,
            clock,
            bwrapPath,
            prlimitPath,
            inputRoot: snapshotRoot,
            jobPath: verificationJobPath,
            runtimeMounts,
            signal,
            onSpawn: (pid) => {
              guard.bindProcess?.(contract.runId, pid);
              assertNotCancelled();
            },
          });
          assertNotCancelled();
          const parsedVerification = parseVerification(verificationRun);
          const verification = parsedVerification && { ...parsedVerification, verifierFamily: contract.routing.reviewerFamily };
          validateVerification(contract, verification, verificationJob);
          validateCurrentQualification(contract, readState(statePath));
          for (const key of ['requests', 'workers', 'readBytes', 'artifactBytes', 'outputBytes']) {
            normalizedExecution.usage[key] += verificationRun.usage[key];
          }
          if (normalizedExecution.usage.requests > contract.budgets.maxRequests
            || normalizedExecution.usage.workers > contract.budgets.maxWorkers
            || normalizedExecution.usage.readBytes > contract.budgets.maxReadBytes
            || normalizedExecution.usage.artifactBytes > contract.budgets.maxArtifactBytes
            || normalizedExecution.usage.outputBytes > contract.budgets.maxOutputBytes) {
            throw new Error('aggregate execution quota exceeded');
          }
          if (Date.parse(clock()) >= Date.parse(activationExpiresAt)) throw new Error('bounded verification expired');
          validateCurrentQualification(contract, readState(statePath));
          const receipt = createReceipt({
            contract,
            execution: normalizedExecution,
            verification,
            completedAt: clock(),
            activatedAt,
            expiresAt: activationExpiresAt,
          });
          if (!verifyReceipt(receipt, contract).valid) throw new Error('receipt self-verification failed');
          await restore('completed');
          validateCurrentQualification(contract, readState(statePath));
          transactionallyDeliver(deliveryRoot, stageRoot, contract, receipt, statePath, baseline);
          return receipt;
        } catch (error) {
          await restore('failed');
          throw error;
        } finally {
          if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
          if (jobRoot) fs.rmSync(jobRoot, { recursive: true, force: true });
        }
      });
    },

    async status() {
      assertRuntimeCapabilities();
      return withStateLock(statePath, flockPath, nodePath, async () => {
        let recovery;
        try { recovery = readRecovery(statePath); }
        catch (error) {
          await guard.rollback('malformed-recovery', { lockHeld: true });
          if (await guard.verifyRollback() !== true) throw new Error('rollback verification failed');
          throw error;
        }
        if (recovery) {
          const reason = !recovery.active
            ? 'crash'
            : Date.parse(recovery.active.expiresAt || '') <= Date.parse(clock()) ? 'expired' : 'drift';
          const baselineDrift = recovery.pending.baseline !== readStateBytes(statePath);
          let qualificationDrift = false;
          if (recovery.active && !baselineDrift) {
            try {
              const current = readState(statePath);
              validateQualification(current, {
                now: clock(),
                taskDigest: recovery.active.taskDigest,
                scopeDigest: recovery.active.scopeDigest,
                evidence: qualificationEvidence(current),
              });
            } catch { qualificationDrift = true; }
          }
          if (reason !== 'drift' || baselineDrift || qualificationDrift || (await guard.status())?.drift === true) {
            await restore(qualificationDrift ? 'qualification-drift' : reason);
          }
        }
        const effective = readState(statePath);
        const active = readRecovery(statePath)?.active ?? null;
        return {
          level: active ? 'L4-bounded' : effective.level,
          active: Boolean(active),
          nextDeadline: active?.expiresAt ?? null,
        };
      });
    },

    async rollback(reason = 'operator') {
      if (typeof reason !== 'string' || !reason.trim()) throw new Error('rollback reason is required');
      assertRuntimeCapabilities();
      return withStateLock(statePath, flockPath, nodePath, () => restore(reason));
    },

    async doctor() {
      const failures = [];
      try {
        const state = readState(statePath);
        validateQualification(state, {
          now: clock(),
          taskDigest: state.qualification.taskDigest,
          scopeDigest: state.qualification.scopeDigest,
          evidence: qualificationEvidence(state),
        });
        assertRuntimeCapabilities();
      }
      catch (error) { failures.push(error.message); }
      let report;
      try { report = await guard.status(); }
      catch { failures.push('guard status is unavailable'); }
      failures.push(...guardHealthFailures(report));
      if (report?.killSwitchActive !== true) failures.push('kill switch is not active');
      if (report?.routingReady !== true) failures.push('routing is not ready');
      if (report?.providersReady !== true) failures.push('providers are not ready');
      if (report?.digestsReady !== true || report?.drift === true) failures.push('qualified digests drifted');
      return { status: failures.length ? 'blocked' : 'ready', failures, diagnostics: guardHealthDiagnostics(report) };
    },
  };
  return Object.freeze(controller);
}
