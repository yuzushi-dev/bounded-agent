import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveOmpPaths } from '../../scripts/install.mjs';
import {
  commandDigest, digest, routing, runtimeMounts, scopeDigestForRequest,
} from '../core/helpers.mjs';
import { stableSerialize } from '../../core/receipt.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const discoveredOmp = (process.env.PATH || '').split(path.delimiter)
  .map((directory) => path.join(directory, 'omp')).find((candidate) => fs.existsSync(candidate));
const ompCommand = process.env.OMP_PATH || discoveredOmp;
if (!ompCommand) throw new Error('OMP_PATH is unset and omp was not found on PATH');
const OMP_PATH = fs.realpathSync(ompCommand);
const OMP_PACKAGE_DIR = path.dirname(path.dirname(OMP_PATH));
const SYSTEMCTL = '/usr/bin/systemctl';
const SERVICE = 'omp-bounded-guard.service';
const TIMER = 'omp-bounded-guard.timer';
const SYSTEMD_LOCK_ROOT = path.join(os.homedir(), '.config', 'systemd', 'user');
const PROVIDER_ENV = /(?:API.?KEY|ACCESS.?KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL)/i;

function command(commandPath, args, options = {}) {
  return spawnSync(commandPath, args, { encoding: 'utf8', timeout: 20_000, ...options });
}

function checked(commandPath, args, options = {}) {
  const result = command(commandPath, args, options);
  assert.equal(result.status, 0, `${commandPath} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
  return String(result.stdout || '').trim();
}

function writeJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function snapshotTree(root, excluded = new Set()) {
  const snapshot = {};
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded.has(relative)) continue;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      assert.equal(entry.isSymbolicLink(), false, relative);
      snapshot[relative] = entry.isDirectory()
        ? { kind: 'directory', mode: stat.mode & 0o777 }
        : { kind: 'file', mode: stat.mode & 0o777, bytes: fs.readFileSync(target).toString('base64') };
      if (entry.isDirectory()) visit(target, relative);
    }
  }
  visit(root);
  return snapshot;
}

function cleanOmpEnvironment(home) {
  const env = { ...process.env, HOME: home };
  for (const name of Object.keys(env)) {
    if (PROVIDER_ENV.test(name)) env[name] = '';
  }
  for (const name of [
    'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  ]) delete env[name];
  env.PI_PACKAGE_DIR = OMP_PACKAGE_DIR;
  return env;
}

function fixture(home, env = {}) {
  const paths = deriveOmpPaths({ home, env });
  const stateRoot = paths.stateRoot;
  const statePath = path.join(stateRoot, 'state.json');
  const deliveryRoot = path.join(stateRoot, 'delivery');
  const inputRoot = path.join(stateRoot, 'inputs');
  const qualificationRoot = path.join(stateRoot, 'qualification');
  for (const directory of [
    path.join(deliveryRoot, 'receipts'), path.join(inputRoot, 'input'),
    path.join(inputRoot, 'sessions'), qualificationRoot,
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(inputRoot, 'input/brief.md'), 'finish\n', { mode: 0o600 });
  fs.writeFileSync(path.join(inputRoot, 'sessions/run.jsonl'), '{"role":"user"}\n', { mode: 0o600 });

  const worker = {
    command: process.execPath,
    args: ['-e', `
const fs=require('fs');
const emit=()=>{const p=Buffer.from('artifacts/result.txt'),d=Buffer.from('x'),h=Buffer.alloc(12);h.writeUInt32BE(p.length,0);h.writeBigUInt64BE(BigInt(d.length),4);process.stdout.write(Buffer.concat([Buffer.from('OMPART1\\n'),h,p,d,Buffer.alloc(12)]))};
if(fs.readFileSync('/inputs/input/brief.md','utf8').trim()==='hold')setTimeout(emit,30000);else emit();
`],
  };
  const verifierCommand = {
    command: process.execPath,
    args: ['-e', `
const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.env.OMP_BOUNDED_JOB,'utf8'));
console.log(JSON.stringify({schema:'omp-independent-verification/v1',passed:true,contractDigest:j.contractDigest,artifactDigest:j.artifactDigest,verdict:'CLEAN',findings:[],objectives:Object.fromEntries(j.outputPaths.map(p=>[p,true]))}));
`],
  };
  const qualificationPaths = {
    sources: { controller: path.join(qualificationRoot, 'controller.mjs') },
    config: path.join(qualificationRoot, 'config.json'),
    suite: path.join(qualificationRoot, 'suite.json'),
    review: path.join(qualificationRoot, 'review.json'),
    capabilities: path.join(qualificationRoot, 'capabilities.json'),
    probe: path.join(qualificationRoot, 'probe.json'),
    node: path.join(qualificationRoot, 'node.json'),
  };
  fs.writeFileSync(qualificationPaths.sources.controller, 'clean-host fixture\n', { mode: 0o600 });
  fs.writeFileSync(qualificationPaths.config, 'no external effects\n', { mode: 0o600 });
  const route = routing();
  const workerCapability = { digest: commandDigest(worker), family: route.chains.find(({ role }) => role === 'task').family };
  const verifierCapability = { digest: commandDigest(verifierCommand), family: route.reviewerFamily };
  const runtimeMountsDigest = digest(stableSerialize(runtimeMounts));
  const nodeDigest = commandDigest({ command: process.execPath, args: [] });
  writeJson(qualificationPaths.capabilities, {
    schema: 'omp-capability-qualification/v1', runtimeMountsDigest, worker: workerCapability, verifier: verifierCapability,
  });
  writeJson(qualificationPaths.node, { schema: 'omp-node-qualification/v1', nodePath: process.execPath, nodeDigest });
  writeJson(qualificationPaths.probe, {
    schema: 'omp-sandbox-capability-probe/v1', passed: true, workerCapability, verifierCapability,
    nodeDigest, runtimeMountsDigest,
  });

  const hostAdmissionDefaults = {
    boundedContext: { sessionPath: 'sessions/run.jsonl', readPaths: ['input/brief.md'], maxBytes: 1024 },
    verifier: { id: 'independent-verifier', digest: verifierCapability.digest },
    requiredGates: ['sandbox', 'trusted-state', 'verifier'],
    retries: { request: 0, worker: 0, transport: 0, semantic: 0 },
    stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    routing: route,
    phase: 'dispatch',
  };
  const qualifiedRequest = {
    ...hostAdmissionDefaults,
    toolCallId: 'qualification', sessionId: 'qualification',
    trigger: { id: 'bounded-command', value: '/bounded run' },
    task: { id: 'bounded-command-task', value: 'write the bounded result' },
    acceptanceCheck: { id: 'bounded-command-acceptance', value: 'artifacts/result.txt contains exactly x' },
    writeScope: { paths: ['artifacts/result.txt'], patchPaths: [], maxFiles: 1 },
    budgets: { maxReadBytes: 1024, maxArtifactBytes: 1024, maxOutputBytes: 1024, maxRequests: 2, maxWorkers: 1 },
    maxSeconds: 30,
    delivery: { mode: 'local', outputPaths: ['artifacts/result.txt'] },
    externalEffects: { enabled: false, finalGate: 'human-approval' },
    prohibitedEffects: 'all external effects',
  };
  const sourceDigests = Object.fromEntries(Object.entries(qualificationPaths.sources)
    .map(([name, file]) => [name, digest(fs.readFileSync(file))]));
  const configDigest = digest(fs.readFileSync(qualificationPaths.config));
  const probeDigest = digest(fs.readFileSync(qualificationPaths.probe));
  const qualification = {
    sourceDigests, configDigest, runtimeMountsDigest, workerCapability, verifierCapability, nodeDigest, probeDigest,
  };
  const scopeDigest = scopeDigestForRequest(qualifiedRequest, qualification);
  const subjectDigest = digest(stableSerialize(qualification));
  const contractDigest = digest(stableSerialize({ subjectDigest, scopeDigest }));
  writeJson(qualificationPaths.suite, {
    schema: 'omp-qualification-suite/v1', passed: true, subjectDigest, contractDigest, scopeDigest,
  });
  writeJson(qualificationPaths.review, {
    schema: 'omp-qualification-review/v1', verdict: 'CLEAN', findings: [], subjectDigest,
    contractDigest, scopeDigest, reviewerFamily: route.reviewerFamily,
  });
  const now = Date.now();
  writeJson(statePath, {
    schema: 'omp-host-trusted-state/v1', level: 'L3-narrow-write',
    killSwitch: { active: true, marker: 'UNATTENDED_MODE_DISABLED' },
    qualification: {
      status: 'ready', ...qualification,
      suiteDigest: digest(fs.readFileSync(qualificationPaths.suite)),
      reviewDigest: digest(fs.readFileSync(qualificationPaths.review)),
      qualifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(),
      taskDigest: digest(qualifiedRequest.task.value), scopeDigest,
    },
    routing: route,
  });
  const config = {
    controller: {
      statePath, deliveryRoot, inputRoot, qualificationPaths, worker, verifierCommand,
      bwrapPath: '/usr/bin/bwrap', prlimitPath: '/usr/bin/prlimit', flockPath: '/usr/bin/flock', runtimeMounts,
    },
    hostAdmissionDefaults,
  };
  return { config, deliveryRoot, inputRoot, paths, statePath, stateRoot };
}

function rpc(child) {
  const frames = [];
  const waiters = new Set();
  let stderr = '';
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { frame = { type: 'invalid_json', line }; }
    frames.push(frame);
    for (const waiter of waiters) {
      if (frame.type === 'extension_ui_request' && frame.method === 'notify'
        && frame.notifyType === 'error'
        && /bounded (?:run|command) rejected:/.test(String(frame.message || ''))) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`bounded RPC rejected: ${frame.message}`));
        continue;
      }
      if (waiter.predicate(frame)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const waitFor = (predicate, label, timeout = 20_000) => {
    const prior = frames.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`timed out waiting for ${label}\n${stderr}\n${JSON.stringify(frames.slice(-10))}`));
      }, timeout);
      waiters.add(waiter);
    });
  };
  return {
    frames,
    send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); },
    waitFor,
    stderr: () => stderr,
  };
}

async function waitForFile(target, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${target}`);
}

async function waitFor(predicate, label, timeout = 75_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function processStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  } catch { return null; }
}

function processGenerationAlive(pid, startTime) {
  if (processStartTime(pid) !== startTime) return false;
  try { process.kill(pid, 0); process.kill(-pid, 0); return true; }
  catch { return false; }
}

function processGenerationGone(pid, startTime) {
  if (processStartTime(pid) === startTime) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (error?.code !== 'ESRCH') return false;
  }
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

function systemdProperties(unit) {
  const result = command(SYSTEMCTL, [
    '--user', 'show', unit, '--property=LoadState', '--property=ActiveState', '--property=SubState',
    '--property=Result', '--property=ExecMainStatus', '--property=ExecMainExitTimestampMonotonic',
  ]);
  return result.status === 0
    ? Object.fromEntries(String(result.stdout || '').trim().split('\n').filter(Boolean).map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1)];
    }))
    : null;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

function unitPaths(configRoot) {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return {
    runtimeService: path.join(runtime, 'systemd/user', SERVICE),
    runtimeTimer: path.join(runtime, 'systemd/user', TIMER),
    persistentTimer: path.join(os.homedir(), '.config/systemd/user/timers.target.wants', TIMER),
    serviceSource: path.join(configRoot, 'systemd/user', SERVICE),
    timerSource: path.join(configRoot, 'systemd/user', TIMER),
  };
}

function assertUnitsAbsent(paths) {
  for (const unit of [SERVICE, TIMER]) {
    assert.equal(checked(SYSTEMCTL, ['--user', 'show', unit, '--property=LoadState', '--value']), 'not-found', unit);
  }
  for (const target of [
    paths.runtimeService, paths.runtimeTimer, paths.persistentTimer, paths.serviceSource, paths.timerSource,
  ]) {
    assert.equal(fs.lstatSync(target, { throwIfNoEntry: false }), undefined, target);
  }
}

async function acquireSystemdLock() {
  const stat = fs.lstatSync(SYSTEMD_LOCK_ROOT);
  assert.equal(stat.isDirectory(), true, SYSTEMD_LOCK_ROOT);
  assert.equal(stat.isSymbolicLink(), false, SYSTEMD_LOCK_ROOT);
  assert.equal(fs.realpathSync(SYSTEMD_LOCK_ROOT), SYSTEMD_LOCK_ROOT, SYSTEMD_LOCK_ROOT);
  assert.equal(typeof process.getuid !== 'function' || stat.uid === process.getuid(), true, SYSTEMD_LOCK_ROOT);
  const holder = spawn('/usr/bin/flock', [
    '-n', SYSTEMD_LOCK_ROOT, process.execPath, '-e', "process.stdout.write('LOCKED\\n');process.stdin.resume()",
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (!settled && output.includes('LOCKED\n')) { settled = true; resolve(); }
    });
    holder.once('error', reject);
    holder.once('exit', (code) => {
      if (!settled) reject(new Error(`systemd E2E lock unavailable (exit ${code})`));
    });
  });
  return async () => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
    if (holder.exitCode === null && holder.signalCode === null) await new Promise((resolve) => holder.once('exit', resolve));
  };
}

function assertCreatedUnitLink(target, allowedTargets) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return false;
  assert.equal(stat.isSymbolicLink(), true, target);
  const link = fs.readlinkSync(target);
  const resolved = path.resolve(path.dirname(target), link);
  assert.equal(allowedTargets.has(resolved), true, `${target} -> ${link}`);
  return true;
}

function removeCreatedUnitLink(target, allowedTargets) {
  if (!assertCreatedUnitLink(target, allowedTargets)) return;
  fs.unlinkSync(target);
}

function checkedOrAbsent(args) {
  const result = command(SYSTEMCTL, args);
  if (result.status !== 0 && !/not loaded|not found|does not exist|no such file/i.test(`${result.stdout || ''}${result.stderr || ''}`)) {
    throw new Error(`${SYSTEMCTL} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  }
}

async function cleanupSystemd(paths, deadlineUnits = []) {
  const links = [
    assertCreatedUnitLink(paths.persistentTimer, new Set([paths.runtimeTimer, paths.timerSource])),
    assertCreatedUnitLink(paths.runtimeTimer, new Set([paths.timerSource])),
    assertCreatedUnitLink(paths.runtimeService, new Set([paths.serviceSource])),
  ];
  if (links.some(Boolean)) {
    checkedOrAbsent(['--user', 'stop', TIMER, SERVICE, ...deadlineUnits]);
    checkedOrAbsent(['--user', 'disable', '--now', TIMER]);
    checkedOrAbsent(['--user', 'disable', '--runtime', '--now', TIMER]);
  } else if (deadlineUnits.length) {
    checkedOrAbsent(['--user', 'stop', ...deadlineUnits]);
  }
  removeCreatedUnitLink(paths.persistentTimer, new Set([paths.runtimeTimer, paths.timerSource]));
  removeCreatedUnitLink(paths.runtimeTimer, new Set([paths.timerSource]));
  removeCreatedUnitLink(paths.runtimeService, new Set([paths.serviceSource]));
  checked(SYSTEMCTL, ['--user', 'daemon-reload']);
  if (links.some(Boolean)) checkedOrAbsent(['--user', 'reset-failed', TIMER, SERVICE, ...deadlineUnits]);
  else if (deadlineUnits.length) checkedOrAbsent(['--user', 'reset-failed', ...deadlineUnits]);
  for (const unit of deadlineUnits) {
    assert.equal(checked(SYSTEMCTL, ['--user', 'show', unit, '--property=LoadState', '--value']), 'not-found', unit);
  }
}

function assertNoDeadlineUnits() {
  for (const args of [
    ['--user', 'list-units', '--all', '--no-legend', 'omp-bounded-deadline-*'],
    ['--user', 'list-unit-files', '--no-legend', 'omp-bounded-deadline-*'],
  ]) {
    const result = command(SYSTEMCTL, args);
    assert.ok(result.status === 0 || (result.status === 1 && !result.stdout && !result.stderr), args.join(' '));
    assert.equal(String(result.stdout || '').trim(), '', args.join(' '));
  }
}

test('clean HOME loads the linked extension, runs locally, recovers after OMP dies, and removes its residue', { timeout: 180_000 }, async () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['test:e2e'], 'node --test --test-concurrency=1 tests/e2e/*.test.mjs');
  for (const name of ['install.md', 'usage.md', 'security.md']) {
    assert.equal(fs.existsSync(path.join(PACKAGE_ROOT, 'docs', name)), true, `docs/${name}`);
  }

  const cacheRoot = path.join(os.homedir(), '.local', 'state');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(cacheRoot, 'omp-bounded-e2e-'));
  const home = path.join(testRoot, 'home');
  const installHome = os.homedir();
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const configRoot = path.join(installHome, '.config');
  const paths = unitPaths(configRoot);
  let child;
  let installed;
  let f;
  let hostFixtureSnapshot;
  let preservedStateTree;
  let systemdOwned = false;
  let systemdPreflightPassed = false;
  let deadlineUnits = [];
  let bodyError;
  let releaseSystemdLock;
  let installerEnv;
  const unitDirectoryModes = [];
  try {
    releaseSystemdLock = await acquireSystemdLock();
    const safeOmpPath = path.join(testRoot, 'omp-17.2.11');
    assert.doesNotMatch(OMP_PATH, /['\n\r]/);
    fs.writeFileSync(safeOmpPath, `#!/bin/sh\nexec '${OMP_PATH}' "$@"\n`, { mode: 0o700 });
    installerEnv = cleanOmpEnvironment(home);
    const xdgDataRoot = path.join(testRoot, 'xdg-data');
    const xdgStateRoot = path.join(testRoot, 'xdg-state');
    fs.mkdirSync(path.join(xdgDataRoot, 'omp'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(xdgStateRoot, 'omp'), { recursive: true, mode: 0o700 });
    installerEnv.XDG_CONFIG_HOME = configRoot;
    installerEnv.XDG_DATA_HOME = xdgDataRoot;
    installerEnv.XDG_STATE_HOME = xdgStateRoot;
    const pluginRoot = path.join(xdgDataRoot, 'omp', 'plugins');
    fs.mkdirSync(pluginRoot, { recursive: true, mode: 0o700 });
    const ompConfigRoot = path.join(home, '.config');
    fs.mkdirSync(ompConfigRoot, { recursive: true, mode: 0o700 });
    const ompEnv = { ...installerEnv, XDG_CONFIG_HOME: ompConfigRoot };
    assert.equal(path.relative(home, ompConfigRoot).startsWith('..'), false);
    assert.deepEqual(fs.readdirSync(ompConfigRoot), []);
    assert.equal(checked(OMP_PATH, ['--version']), 'omp/17.2.11');
    assertUnitsAbsent(paths);
    assertNoDeadlineUnits();
    systemdPreflightPassed = true;
    assert.deepEqual(fs.readdirSync(home), ['.config']);
    for (const directory of [path.join(configRoot, 'systemd'), path.join(configRoot, 'systemd/user')]) {
      const stat = fs.lstatSync(directory);
      assert.equal(stat.isDirectory(), true, directory);
      assert.equal(stat.isSymbolicLink(), false, directory);
      unitDirectoryModes.push({ directory, mode: stat.mode & 0o777 });
      fs.chmodSync(directory, 0o700);
    }
    f = fixture(installHome, installerEnv);
    hostFixtureSnapshot = fs.readFileSync(f.statePath);
    const tempOmpTreeSnapshot = {
      config: snapshotTree(ompConfigRoot), plugins: snapshotTree(pluginRoot),
    };
    const configPath = path.join(testRoot, 'qualified-installation.json');
    writeJson(configPath, f.config);
    const priorUmask = process.umask(0o077);
    try {
      const result = command(process.execPath, [path.join(PACKAGE_ROOT, 'scripts/install.mjs'),
        '--config', configPath, '--omp', safeOmpPath], { env: installerEnv, timeout: 60_000 });
      assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
      installed = JSON.parse(result.stdout);
    } finally { process.umask(priorUmask); }
    assert.equal(fs.realpathSync(path.join(f.paths.pluginsRoot, 'node_modules/omp-bounded')), PACKAGE_ROOT);

    systemdOwned = true;
    assert.equal(fs.lstatSync(paths.serviceSource).isFile(), true);
    assert.equal(fs.lstatSync(paths.timerSource).isFile(), true);
    assert.equal(checked(SYSTEMCTL, ['--user', 'is-enabled', TIMER]), 'enabled');
    assert.equal(checked(SYSTEMCTL, ['--user', 'is-active', TIMER]), 'active');

    child = spawn(safeOmpPath, ['--mode', 'rpc', '--no-session', '--no-tools', '--no-skills', '--cwd', f.deliveryRoot], {
      env: ompEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = rpc(child);
    await client.waitFor(({ type }) => type === 'ready', 'OMP RPC ready');
    const commands = await client.waitFor(({ type }) => type === 'available_commands_update', 'available commands');
    assert.equal(commands.commands.some(({ name }) => name === 'bounded'), true);
    assert.equal(client.frames.some(({ type }) => type === 'extension_error'), false, client.stderr());

    client.send({ id: 'doctor', type: 'prompt', message: '/bounded doctor' });
    const doctor = await client.waitFor((frame) => frame.type === 'extension_ui_request'
      && frame.method === 'notify' && /"status":"ready"/.test(frame.message), '/bounded doctor');
    assert.equal(doctor.notifyType, 'info');
    await client.waitFor((frame) => frame.type === 'prompt_result' && frame.id === 'doctor', 'doctor completion');

    const runCommand = '/bounded run --task "write the bounded result" --acceptance "artifacts/result.txt contains exactly x" --scope artifacts/result.txt --max-seconds 30 --max-read-bytes 1024 --max-artifact-bytes 1024 --max-output-bytes 1024 --max-requests 2 --prohibited-effects "all external effects" --final-gate human-approval';
    client.send({ id: 'run', type: 'prompt', message: runCommand });
    const confirmation = await client.waitFor((frame) => frame.type === 'extension_ui_request'
      && frame.method === 'confirm', 'bounded confirmation');
    const preview = JSON.parse(confirmation.message);
    assert.equal(preview.task, 'write the bounded result');
    assert.equal(preview.prohibitedEffects, 'all external effects');
    assert.equal(preview.request.externalEffects.enabled, false);
    client.send({ type: 'extension_ui_response', id: confirmation.id, confirmed: true });
    await client.waitFor((frame) => frame.type === 'extension_ui_request' && frame.method === 'notify'
      && /"status":"delivered"/.test(frame.message), 'bounded receipt', 30_000);
    assert.equal(fs.readFileSync(path.join(f.deliveryRoot, 'artifacts/result.txt'), 'utf8'), 'x');
    assert.deepEqual(fs.readFileSync(f.statePath), hostFixtureSnapshot);

    fs.writeFileSync(path.join(f.inputRoot, 'input/brief.md'), 'hold\n', { mode: 0o600 });
    const installerOwned = new Set(['installation.json', 'install-receipt.json', 'install-pending.json', 'state.json.deadline-evidence', 'state.json.guard-heartbeat']);
    client.send({ id: 'crash', type: 'prompt', message: runCommand });
    const crashConfirmation = await client.waitFor((frame) => frame.type === 'extension_ui_request'
      && frame.method === 'confirm' && frame.id !== confirmation.id, 'crash-run confirmation');
    client.send({ type: 'extension_ui_response', id: crashConfirmation.id, confirmed: true });
    await waitForFile(`${f.statePath}.recovery`);
    await waitForFile(`${f.statePath}.guard`);
    const lease = JSON.parse(fs.readFileSync(`${f.statePath}.guard`, 'utf8'));
    assert.match(lease.deadlineUnit, /^omp-bounded-deadline-[a-f0-9]{24}$/);
    deadlineUnits = [`${lease.deadlineUnit}.timer`, `${lease.deadlineUnit}.service`];
    const deadlineTimer = systemdProperties(deadlineUnits[0]);
    assert.equal(deadlineTimer?.LoadState, 'loaded');
    const deadlineService = systemdProperties(deadlineUnits[1]);
    assert.equal(deadlineService?.LoadState, 'loaded');
    let workerLease;
    await waitFor(() => {
      const current = JSON.parse(fs.readFileSync(`${f.statePath}.guard`, 'utf8'));
      if (Number.isInteger(current.workerPid) && current.workerPid > 0
        && /^\d+$/.test(current.workerStartTime || '')
        && processGenerationAlive(current.workerPid, current.workerStartTime)) {
        workerLease = current;
        return true;
      }
      return false;
    }, 'leased worker process');
    await stopChild(child);
    child = undefined;
    await waitFor(() => deadlineUnits.every((unit) => {
      const current = systemdProperties(unit);
      return !current || current.LoadState === 'not-found';
    }), 'deadline transient unit collection');
    await waitFor(() => processGenerationGone(workerLease.workerPid, workerLease.workerStartTime), 'worker process-group exit');
    await waitFor(() => {
      if (['.recovery', '.guard', '.cancel'].some((suffix) => fs.existsSync(`${f.statePath}${suffix}`))) return false;
      if (!fs.existsSync(f.statePath) || !fs.readFileSync(f.statePath).equals(hostFixtureSnapshot)) return false;
      return true;
    }, 'automatic systemd crash or deadline reconciliation');
    assert.deepEqual(fs.readFileSync(f.statePath), hostFixtureSnapshot);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath, 'utf8')), {
      ...JSON.parse(hostFixtureSnapshot),
      level: 'L3-narrow-write',
      killSwitch: { active: true, marker: 'UNATTENDED_MODE_DISABLED' },
    });
    for (const suffix of ['.recovery', '.guard', '.cancel']) assert.equal(fs.existsSync(`${f.statePath}${suffix}`), false);
    assert.equal(fs.existsSync(path.join(f.deliveryRoot, 'receipts', `.stage-${lease.runId}`)), false);
    assert.equal(fs.existsSync(path.join(f.deliveryRoot, 'receipts', `.job-${lease.runId}`)), false);

    preservedStateTree = snapshotTree(f.stateRoot, installerOwned);
    const pluginOwnedPaths = [
      path.join(f.paths.pluginsRoot, 'node_modules/omp-bounded'),
      path.join(f.paths.pluginsRoot, 'omp-plugins.lock.json'),
      path.join(f.paths.pluginsRoot, 'package.json'), path.join(f.paths.pluginsRoot, 'bun.lock'),
      path.join(f.paths.pluginsRoot, 'bun.lockb'),
      path.join(f.stateRoot, 'installation.json'), path.join(f.stateRoot, 'install-receipt.json'),
      path.join(f.stateRoot, 'install-pending.json'), `${f.statePath}.deadline-evidence`,
      `${f.statePath}.guard-heartbeat`,
      paths.serviceSource, paths.timerSource,
    ];
    const uninstallResult = command(process.execPath, [path.join(PACKAGE_ROOT, 'scripts/uninstall.mjs'),
      '--manifest', installed.manifestPath], { env: installerEnv, timeout: 60_000 });
    assert.equal(uninstallResult.status, 0, `${uninstallResult.stdout || ''}${uninstallResult.stderr || ''}`);
    assert.equal(JSON.parse(uninstallResult.stdout).status, 'uninstalled');
    installed = undefined;
    assert.deepEqual(fs.readFileSync(f.statePath), hostFixtureSnapshot);
    assert.deepEqual(snapshotTree(f.stateRoot, installerOwned), preservedStateTree);
    for (const target of [...pluginOwnedPaths, `${f.statePath}.recovery`, `${f.statePath}.guard`, `${f.statePath}.cancel`]) {
      assert.equal(fs.existsSync(target), false, target);
    }
    assert.deepEqual({ config: snapshotTree(ompConfigRoot), plugins: snapshotTree(pluginRoot) }, tempOmpTreeSnapshot);
    await cleanupSystemd(paths, deadlineUnits);
    systemdOwned = false;
    assertUnitsAbsent(paths);
    assertNoDeadlineUnits();
  } catch (error) {
    bodyError = error;
  } finally {
    const cleanupErrors = [];
    try { await stopChild(child); } catch (error) { cleanupErrors.push(error); }
    if (installed?.manifestPath && fs.existsSync(installed.manifestPath)) {
      try {
        const result = command(process.execPath, [path.join(PACKAGE_ROOT, 'scripts/uninstall.mjs'),
          '--manifest', installed.manifestPath], { env: installerEnv, timeout: 60_000 });
        if (result.status !== 0) throw new Error(`${result.stdout || ''}${result.stderr || ''}`);
      }
      catch (error) { cleanupErrors.push(error); }
    }
    if (systemdOwned) {
      try { await cleanupSystemd(paths, deadlineUnits); } catch (error) { cleanupErrors.push(error); }
    }
    if (systemdPreflightPassed) {
      try { assertUnitsAbsent(paths); } catch (error) { cleanupErrors.push(error); }
      try { assertNoDeadlineUnits(); } catch (error) { cleanupErrors.push(error); }
    }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    for (const { directory, mode } of unitDirectoryModes.reverse()) {
      try { fs.chmodSync(directory, mode); } catch (error) { cleanupErrors.push(error); }
    }
    try { await releaseSystemdLock?.(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError([bodyError, ...cleanupErrors].filter(Boolean), 'clean-host E2E cleanup failed');
  }
  if (bodyError) throw bodyError;
});
