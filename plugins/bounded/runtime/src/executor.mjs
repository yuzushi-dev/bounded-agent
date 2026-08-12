import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { sha256 } from './contract.mjs';

const BWRAP = '/usr/bin/bwrap';
const SAFE_RELATIVE = (value) => typeof value === 'string' && !path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && !value.split('/').some((part) => part === '.' || part === '..');

function processStartTime(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2).trim().split(/\s+/)[19]; }
  catch { return null; }
}

function ensureParent(root, relative) {
  const target = path.join(root, ...relative.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('sandbox path escaped root');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

function safeSource(root, relative) {
  if (!SAFE_RELATIVE(relative)) throw new Error('sandbox input path is invalid');
  let target = root;
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('sandbox input root is not a safe directory');
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('sandbox input path contains a symlink');
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error('sandbox input is not a safe file');
  return target;
}

function mountParents(args, mounted, target) {
  let current = path.dirname(target);
  while (current !== '/') {
    if (!mounted.has(current)) { args.push('--dir', current); mounted.add(current); }
    current = path.dirname(current);
  }
}

function processGroupAlive(child) {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

function terminate(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

function stageFiles(stageRoot, outputs) {
  const listed = [];
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('sandbox produced a symlink');
      if (entry.isDirectory()) visit(full, relative);
      else if (entry.isFile()) listed.push(relative);
      else throw new Error('sandbox produced a non-regular output');
    }
  }
  visit(stageRoot);
  const allowed = new Set(outputs);
  if (listed.some((value) => !allowed.has(value))) throw new Error('sandbox produced an undeclared output');
  return outputs.map((relative) => {
    const target = path.join(stageRoot, ...relative.split('/'));
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('sandbox output is invalid');
    const bytes = fs.readFileSync(target);
    return { path: relative, bytes: bytes.length, digest: sha256(bytes) };
  });
}

function assertNoBaseWrites(baseRoot, allowed) {
  const listed = [];
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('sandbox produced a symlink');
      listed.push(relative);
      if (entry.isDirectory()) visit(full, relative);
    }
  }
  visit(baseRoot);
  const allowedSet = new Set(allowed);
  if (listed.some((value) => !allowedSet.has(value) && ![...allowedSet].some((item) => item.startsWith(`${value}/`)))) {
    throw new Error('sandbox produced an undeclared write');
  }
}

function commandMounts(args, mounted, command) {
  const real = fs.realpathSync(command);
  mountParents(args, mounted, real);
  args.push('--ro-bind', real, real);
}

function bwrapArgs(contract, stageRoot, baseRoot) {
  const args = [
    '--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', baseRoot, '/workspace',
  ];
  const mounted = new Set(['/usr', '/bin', '/lib', '/lib64', '/proc', '/dev', '/tmp', '/workspace']);
  for (const relative of contract.boundedContext.readPaths) {
    const source = safeSource(contract.cwd, relative);
    const target = `/workspace/${relative}`;
    mountParents(args, mounted, target);
    args.push('--ro-bind', source, target);
  }
  for (const relative of contract.delivery.outputPaths) {
    const target = `/workspace/${relative}`;
    const source = path.join(stageRoot, ...relative.split('/'));
    mountParents(args, mounted, target);
    args.push('--bind', source, target);
  }
  commandMounts(args, mounted, contract.worker.command);
  args.push('--chdir', '/workspace', '--setenv', 'HOME', '/nonexistent', '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'BOUNDED_RUN_ID', contract.runId, '--', contract.worker.command, ...contract.worker.args);
  return args;
}

export async function executeWorker(contract, { stageRoot, signal, onWorkerStart } = {}) {
  if (!fs.existsSync(BWRAP)) return { status: 'failed', reason: 'bubblewrap is unavailable', artifacts: [], counters: {} };
  fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-base-'));
  const outputs = contract.delivery.outputPaths;
  try {
    for (const relative of outputs) {
      const target = ensureParent(stageRoot, relative);
      fs.closeSync(fs.openSync(target, 'w', 0o600));
      ensureParent(baseRoot, relative);
    }
    for (const relative of contract.boundedContext.readPaths) {
      const target = ensureParent(baseRoot, relative);
      if (!fs.existsSync(target)) fs.closeSync(fs.openSync(target, 'w', 0o600));
    }
    const args = bwrapArgs(contract, stageRoot, baseRoot);
    const child = spawn(BWRAP, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const startTime = processStartTime(child.pid);
    if (typeof startTime !== 'string') {
      terminate(child);
      return { status: 'failed', reason: 'worker identity is unavailable', outputBytes: 0, artifacts: [] };
    }
    onWorkerStart?.({ pid: child.pid, startTime });
    const chunks = [];
    let bytes = 0;
    let overBudget = false;
    let deadline = false;
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes > contract.budgets.maxOutputBytes) { overBudget = true; terminate(child); return; }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(() => { deadline = true; terminate(child); }, Math.max(1, Date.parse(contract.expiresAt) - Date.now()));
    const result = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ status: 'failed', reason: error.message, child }));
      child.once('close', (code, signalName) => resolve({ status: code === 0 ? 'completed' : 'failed', code, signal: signalName, child }));
      signal?.addEventListener('abort', () => terminate(child), { once: true });
    });
    clearTimeout(timeout);
    if (overBudget) return { status: 'failed', reason: 'output budget exceeded', outputBytes: bytes, artifacts: [] };
    if (deadline) return { status: 'failed', reason: 'deadline exceeded', outputBytes: bytes, artifacts: [] };
    if (signal?.aborted) return { status: 'failed', reason: 'runtime aborted', outputBytes: bytes, artifacts: [] };
    const output = Buffer.concat(chunks).toString('utf8');
    if (result.status !== 'completed') return { status: 'failed', reason: `worker exited (${result.code ?? result.signal})`, outputBytes: bytes, output, artifacts: [] };
    try {
      assertNoBaseWrites(baseRoot, [...contract.boundedContext.readPaths, ...outputs]);
      const artifacts = stageFiles(stageRoot, outputs);
      return { status: 'completed', sandboxed: true, outputBytes: bytes, output, artifacts, workerPid: result.child.pid };
    } catch (error) {
      return { status: 'failed', reason: error.message, outputBytes: bytes, artifacts: [] };
    }
  } catch (error) {
    return { status: 'failed', reason: error.message, artifacts: [], outputBytes: 0 };
  } finally {
    fs.rmSync(baseRoot, { recursive: true, force: true });
  }
}
