import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import { deriveOmpPaths, install, parseInstallArgs } from '../../scripts/install.mjs';
import { restoreSnapshot, snapshot } from '../../scripts/install-state.mjs';
import { parseUninstallArgs, uninstall } from '../../scripts/uninstall.mjs';
import { loadInstalledComposition } from '../../extensions/bounded-autonomy.mjs';
import { withStateLock } from '../../core/state.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-install-'));
  fs.chmodSync(home, 0o700);
  const ompRoot = path.join(home, '.omp');
  const stateRoot = path.join(ompRoot, 'agent', 'omp-bounded');
  const packageRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (const directory of ['delivery/receipts', 'inputs', 'qualification']) {
    fs.mkdirSync(path.join(stateRoot, directory), { recursive: true, mode: 0o700 });
  }
  const statePath = path.join(stateRoot, 'state.json');
  fs.writeFileSync(statePath, `${JSON.stringify({
    schema: 'omp-host-trusted-state/v1',
    level: 'L3-narrow-write',
    killSwitch: { active: true, marker: 'UNATTENDED_MODE_DISABLED' },
    qualification: {},
    routing: {},
  })}\n`, { mode: 0o600 });
  const config = {
    controller: {
      statePath,
      deliveryRoot: path.join(stateRoot, 'delivery'),
      inputRoot: path.join(stateRoot, 'inputs'),
      qualificationPaths: {
        sources: { controller: path.join(stateRoot, 'qualification/controller.mjs') },
        config: path.join(stateRoot, 'qualification/config.json'),
        suite: path.join(stateRoot, 'qualification/suite.json'),
        review: path.join(stateRoot, 'qualification/review.json'),
        capabilities: path.join(stateRoot, 'qualification/capabilities.json'),
        probe: path.join(stateRoot, 'qualification/probe.json'),
        node: path.join(stateRoot, 'qualification/node.json'),
      },
      worker: { command: process.execPath, args: ['worker.mjs'] },
      verifierCommand: { command: process.execPath, args: ['verify.mjs'] },
      bwrapPath: '/usr/bin/bwrap',
      prlimitPath: '/usr/bin/prlimit',
      flockPath: '/usr/bin/flock',
      runtimeMounts: [{ source: '/usr', target: '/usr' }],
    },
    hostAdmissionDefaults: {
      boundedContext: { sessionPath: 'sessions/run.jsonl', readPaths: ['input/brief.md'], maxBytes: 1024 },
      verifier: { id: 'independent-verifier', digest: `sha256:${'a'.repeat(64)}` },
      requiredGates: ['sandbox', 'trusted-state', 'verifier'],
      retries: { request: 0, worker: 0, transport: 0, semantic: 0 },
      stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
      routing: {
        reviewerFamily: 'anthropic',
        chains: [
          { role: 'task', family: 'openai-codex', selectors: ['openai-codex/model'] },
          { role: 'reviewer', family: 'anthropic', selectors: ['anthropic/model'] },
        ],
      },
      phase: 'dispatch',
    },
  };
  const calls = [];
  const ompPath = path.join(home, 'fake-omp');
  const systemctlPath = path.join(home, 'fake-systemctl');
  fs.writeFileSync(ompPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(systemctlPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  let timerActive = false;
  let timerEnabled = 'disabled';
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === fs.realpathSync(ompPath) && args[0] === 'plugin' && args[1] === 'link') {
      const plugins = path.join(ompRoot, 'plugins');
      const link = path.join(plugins, 'node_modules', 'omp-bounded');
      fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
      fs.rmSync(link, { force: true });
      fs.symlinkSync(packageRoot, link);
      fs.writeFileSync(path.join(plugins, 'omp-plugins.lock.json'), `${JSON.stringify({
        plugins: { 'omp-bounded': { version: '0.0.0', enabledFeatures: null, enabled: true } }, settings: {},
      })}\n`, { mode: 0o600 });
    }
    if (args.join(' ') === '--user enable --now omp-bounded-guard.timer') timerActive = true;
    if (args.includes('enable') && args.at(-1) === 'omp-bounded-guard.timer') {
      timerEnabled = args.includes('--runtime') ? 'enabled-runtime' : 'enabled';
      if (args.includes('--now')) timerActive = true;
    }
    if (args.join(' ') === '--user disable --now omp-bounded-guard.timer') {
      timerActive = false;
      timerEnabled = 'disabled';
    }
    if (args.join(' ') === '--user start omp-bounded-guard.timer') timerActive = true;
    if (args.join(' ') === '--user start omp-bounded-guard.service') {
      if (timerActive) return { status: 1, stdout: '', stderr: 'timer is active' };
      fs.writeFileSync(path.join(stateRoot, 'state.json.guard-heartbeat'), `${JSON.stringify({
        schema: 'omp-bounded-guard-heartbeat/v1', monotonicUs: Number(process.hrtime.bigint() / 1000n),
      })}\n`, { mode: 0o600 });
      const probe = spawnSync('/usr/bin/flock', [
        '-n', stateRoot, '/usr/bin/true',
      ]);
      return { status: probe.status, stdout: '', stderr: '' };
    }
    if (args.join(' ') === '--user is-active omp-bounded-guard.service') {
      return { status: 3, stdout: 'inactive\n', stderr: '' };
    }
    if (args.join(' ') === '--user show omp-bounded-guard.service --property=Result --property=ExecMainStatus --property=ExecMainExitTimestampMonotonic') {
      return { status: 0, stdout: 'Result=success\nExecMainStatus=0\nExecMainExitTimestampMonotonic=1234\n', stderr: '' };
    }
    if (args.includes('is-enabled')) return {
      status: timerEnabled === 'disabled' ? 1 : 0, stdout: `${timerEnabled}\n`, stderr: '',
    };
    if (args.includes('is-active')) return { status: timerActive ? 0 : 3, stdout: timerActive ? 'active\n' : 'inactive\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, config, home, ompPath, ompRoot, packageRoot, run, stateRoot, systemctlPath };
}

test('derives OMP roots from the temporary home and rejects unsafe profiles', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-paths-'));
  try {
    assert.deepEqual(deriveOmpPaths({ home, env: {} }), {
      ompRoot: path.join(home, '.omp'),
      agentRoot: path.join(home, '.omp', 'agent'),
      pluginsRoot: path.join(home, '.omp', 'plugins'),
      stateRoot: path.join(home, '.omp', 'agent', 'omp-bounded'),
      systemdUnitDir: path.join(home, '.config', 'systemd', 'user'),
    });
    assert.throws(() => deriveOmpPaths({ home, env: { OMP_PROFILE: '../escape' } }), /profile/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('copies OMP 17.2.11 profile, agent override, and XDG path semantics', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-paths-exact-'));
  try {
    const profileAgent = path.join(home, '.omp', 'profiles', 'work', 'agent');
    assert.equal(deriveOmpPaths({
      home, env: { OMP_PROFILE: '', PI_PROFILE: 'work', PI_CODING_AGENT_DIR: profileAgent },
    }).agentRoot, path.join(home, '.omp', 'agent'));
    assert.equal(deriveOmpPaths({ home, env: { OMP_PROFILE: ' work ' } }).agentRoot, profileAgent);
    assert.equal(deriveOmpPaths({
      home, env: { PI_CODING_AGENT_DIR: path.join(home, 'custom-agent') },
    }).agentRoot, path.join(home, 'custom-agent'));
    const data = path.join(home, 'xdg-data', 'omp');
    const state = path.join(home, 'xdg-state', 'omp');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    const resolved = deriveOmpPaths({
      home, platform: 'linux', env: { XDG_DATA_HOME: path.dirname(data), XDG_STATE_HOME: path.dirname(state) },
    });
    assert.equal(resolved.pluginsRoot, path.join(data, 'plugins'));
    assert.equal(resolved.stateRoot, path.join(state, 'omp-bounded'));
    const explicitConfig = '/tmp/explicit-omp';
    assert.equal(deriveOmpPaths({
      home, env: { PI_CONFIG_DIR: explicitConfig },
    }).ompRoot, path.join(home, explicitConfig));
    assert.equal(deriveOmpPaths({
      home, env: { PI_CONFIG_DIR: 'relative-omp' },
    }).ompRoot, path.join(home, 'relative-omp'));
    assert.equal(deriveOmpPaths({ home, env: { PI_CONFIG_DIR: '' } }).ompRoot, path.join(home, '.omp'));
    assert.equal(deriveOmpPaths({
      home, env: { PI_CONFIG_DIR: explicitConfig, OMP_PROFILE: 'work' },
    }).ompRoot, path.join(home, explicitConfig, 'profiles', 'work'));
    assert.equal(deriveOmpPaths({
      home, env: { XDG_CONFIG_HOME: path.join(home, 'xdg-config') },
    }).systemdUnitDir, path.join(home, 'xdg-config', 'systemd', 'user'));
    assert.equal(deriveOmpPaths({
      home, env: { XDG_CONFIG_HOME: '' },
    }).systemdUnitDir, path.join(home, '.config', 'systemd', 'user'));
    assert.equal(deriveOmpPaths({
      home, env: { XDG_CONFIG_HOME: 'relative-config' },
    }).systemdUnitDir, path.join(home, '.config', 'systemd', 'user'));
    for (const profile of ['.', '..', 'ends.', 'CON', 'UPPER']) {
      assert.throws(() => deriveOmpPaths({ home, env: { OMP_PROFILE: profile } }), /profile/i);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI option parsers reject missing values before selecting any default path', () => {
  assert.throws(() => parseInstallArgs(['--config']), /usage|requires/i);
  assert.throws(() => parseInstallArgs(['--config', '/tmp/config', '--omp']), /requires/i);
  assert.throws(() => parseUninstallArgs(['--manifest']), /requires/i);
});

test('snapshot restoration preserves exact modes under a hardened umask', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-mode-'));
  const target = path.join(root, 'owned.json');
  const priorUmask = process.umask(0o077);
  try {
    fs.writeFileSync(target, '{}\n', { mode: 0o600 });
    fs.chmodSync(target, 0o644);
    const saved = snapshot(target);
    fs.rmSync(target);
    restoreSnapshot(target, saved);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  } finally {
    process.umask(priorUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install rejects a preexisting active guard service before writing owned files', async () => {
  const f = fixture();
  try {
    const run = (command, args, options) => args.join(' ') === '--user is-active omp-bounded-guard.service'
      ? { status: 0, stdout: 'active\n', stderr: '' }
      : f.run(command, args, options);
    await assert.rejects(install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run,
    }), /service.*active/i);
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'installation.json')), false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('install and uninstall are idempotent, timer-gated, and clean only owned files', async () => {
  const f = fixture();
  try {
    const first = await install({
      home: f.home,
      env: {},
      packageRoot: f.packageRoot,
      config: f.config,
      ompPath: f.ompPath,
      systemctlPath: f.systemctlPath,
      run: f.run,
    });
    const second = await install({
      home: f.home,
      env: {},
      packageRoot: f.packageRoot,
      config: f.config,
      ompPath: f.ompPath,
      systemctlPath: f.systemctlPath,
      run: f.run,
    });

    assert.equal(first.status, 'installed');
    assert.equal(second.status, 'installed');
    assert.equal(fs.existsSync(first.manifestPath), true);
    assert.equal(fs.existsSync(path.join(f.home, '.config/systemd/user/omp-bounded-guard.service')), true);
    assert.equal(fs.existsSync(path.join(f.home, '.config/systemd/user/omp-bounded-guard.timer')), true);
    assert.equal(f.calls.some(([, args]) => args.join(' ') === '--user enable omp-bounded-guard.timer'), true);
    assert.equal(f.calls.some(([, args]) => args.join(' ') === '--user enable --now omp-bounded-guard.timer'), false);
    assert.equal(f.calls.some(([, args]) => args.join(' ') === '--user is-active omp-bounded-guard.timer'), true);
    assert.equal(f.calls.some(([, args]) => args.join(' ') === '--user start omp-bounded-guard.service'), true);
    const order = f.calls.map(([, args]) => args.join(' '));
    assert.ok(order.indexOf('--user enable omp-bounded-guard.timer')
      < order.indexOf('--user start omp-bounded-guard.service'));
    assert.ok(order.indexOf('--user start omp-bounded-guard.service')
      < order.indexOf('--user start omp-bounded-guard.timer'));
    assert.doesNotMatch(fs.readFileSync(first.manifestPath, 'utf8'), /credential|password|apiKey|token|secret/i);
    assert.doesNotMatch(
      fs.readFileSync(path.join(f.stateRoot, 'install-receipt.json'), 'utf8'),
      /credential|password|apiKey|token|secret/i,
    );
    assert.throws(() => loadInstalledComposition(first.manifestPath, { run: f.run }), /qualification|evidence|state schema/i);

    assert.equal((await uninstall({ manifestPath: first.manifestPath, run: f.run })).status, 'uninstalled');
    assert.equal((await uninstall({ manifestPath: first.manifestPath, run: f.run })).status, 'absent');
    assert.equal(fs.existsSync(first.manifestPath), false);
    assert.equal(fs.existsSync(path.join(f.home, '.config/systemd/user/omp-bounded-guard.service')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.config/systemd/user/omp-bounded-guard.timer')), false);
    assert.equal(fs.existsSync(path.join(f.stateRoot, '.install.lock')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.config')), false);
    assert.equal(fs.existsSync(path.join(f.ompRoot, 'plugins')), false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('uninstall retry removes exact bound scratch after an interrupted run', async () => {
  const f = fixture();
  try {
    const installed = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    });
    const runId = `run_${'a'.repeat(24)}`;
    const receiptRoot = path.join(f.config.controller.deliveryRoot, 'receipts');
    const stage = `.stage-${runId}`;
    const job = `.job-${runId}`;
    const unrelated = `.job-${runId}-host-owned`;
    fs.mkdirSync(path.join(receiptRoot, stage), { mode: 0o700 });
    fs.mkdirSync(path.join(receiptRoot, job), { mode: 0o700 });
    fs.mkdirSync(path.join(receiptRoot, unrelated), { mode: 0o700 });
    fs.writeFileSync(path.join(receiptRoot, unrelated, 'keep'), 'host-owned', { mode: 0o600 });
    const baseline = fs.readFileSync(f.config.controller.statePath, 'utf8');
    fs.writeFileSync(f.config.controller.statePath, `${JSON.stringify({
      ...JSON.parse(baseline), level: 'L4-bounded', killSwitch: { active: false, marker: 'UNATTENDED_MODE_DISABLED' },
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${f.config.controller.statePath}.recovery`, `${JSON.stringify({
      schema: 'omp-bounded-recovery/v1',
      pending: { runId, baseline, reason: 'activation' },
      active: {
        runId, activatedAt: '2026-08-11T00:00:00.000Z', expiresAt: '2026-08-11T00:10:00.000Z',
        contractDigest: `sha256:${'1'.repeat(64)}`, taskDigest: `sha256:${'2'.repeat(64)}`,
        scopeDigest: `sha256:${'3'.repeat(64)}`,
      },
      scratch: { root: receiptRoot, stage, job },
    })}\n`, { mode: 0o600 });

    assert.equal((await uninstall({ manifestPath: installed.manifestPath, run: f.run })).status, 'uninstalled');
    assert.equal(fs.existsSync(path.join(receiptRoot, stage)), false);
    assert.equal(fs.existsSync(path.join(receiptRoot, job)), false);
    assert.equal(fs.readFileSync(path.join(receiptRoot, unrelated, 'keep'), 'utf8'), 'host-owned');
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('install rejects symlinked state roots and credentials before changing systemd', async () => {
  const f = fixture();
  try {
    const target = `${f.stateRoot}-real`;
    fs.renameSync(f.stateRoot, target);
    fs.symlinkSync(target, f.stateRoot);
    await assert.rejects(install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    }), /symlink|state root/i);
    assert.deepEqual(f.calls, []);

    fs.unlinkSync(f.stateRoot);
    fs.renameSync(target, f.stateRoot);
    f.config.hostAdmissionDefaults.apiToken = 'credential-value';
    await assert.rejects(install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    }), /credential/i);
    assert.deepEqual(f.calls, []);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('uninstall restores the exact prior OMP plugin entry and link', async () => {
  const f = fixture();
  const pluginsRoot = path.join(f.ompRoot, 'plugins');
  const linkPath = path.join(pluginsRoot, 'node_modules', 'omp-bounded');
  const lockPath = path.join(pluginsRoot, 'omp-plugins.lock.json');
  const previousPackage = path.join(f.home, 'previous-plugin');
  fs.mkdirSync(previousPackage);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.chmodSync(pluginsRoot, 0o700);
  fs.chmodSync(path.dirname(linkPath), 0o700);
  fs.symlinkSync(previousPackage, linkPath);
  const previousEntry = { version: '9.0.0', enabledFeatures: ['safe-feature'], enabled: false };
  const previousSetting = { mode: 'prior' };
  let timerRunning = false;
  let timerEnabled = false;
  fs.writeFileSync(lockPath, `${JSON.stringify({
    plugins: { 'omp-bounded': previousEntry }, settings: { 'omp-bounded': previousSetting },
  })}\n`, { mode: 0o600 });
  const run = (command, args) => {
    f.calls.push([command, args]);
    if (command === fs.realpathSync(f.ompPath) && args[0] === 'plugin' && args[1] === 'link') {
      fs.rmSync(linkPath);
      fs.symlinkSync(f.packageRoot, linkPath);
      fs.writeFileSync(lockPath, `${JSON.stringify({
        plugins: { 'omp-bounded': { version: '0.0.0', enabledFeatures: null, enabled: true } },
        settings: { 'omp-bounded': { mode: 'installed' } },
      })}\n`);
    }
    if (command === fs.realpathSync(f.ompPath) && args[0] === 'plugin' && args[1] === 'uninstall') {
      fs.rmSync(linkPath, { force: true });
      fs.writeFileSync(lockPath, `${JSON.stringify({ plugins: {}, settings: {} })}\n`);
    }
    if (args.join(' ') === '--user is-active omp-bounded-guard.service') {
      return { status: 3, stdout: 'inactive\n', stderr: '' };
    }
    if (args.includes('is-active')) {
      return { status: timerRunning ? 0 : 3, stdout: timerRunning ? 'active\n' : 'inactive\n', stderr: '' };
    }
    if (args.includes('is-enabled')) {
      return { status: timerEnabled ? 0 : 1, stdout: timerEnabled ? 'enabled\n' : 'disabled\n', stderr: '' };
    }
    if (args.join(' ') === '--user disable --now omp-bounded-guard.timer') timerRunning = false;
    if (args.join(' ') === '--user enable omp-bounded-guard.timer') timerEnabled = true;
    if (args.join(' ') === '--user start omp-bounded-guard.timer') timerRunning = true;
    if (args.join(' ') === '--user start omp-bounded-guard.service') {
      fs.writeFileSync(path.join(f.stateRoot, 'state.json.guard-heartbeat'), `${JSON.stringify({
        schema: 'omp-bounded-guard-heartbeat/v1', monotonicUs: Number(process.hrtime.bigint() / 1000n),
      })}\n`, { mode: 0o600 });
    }
    if (args.includes('show')) {
      return { status: 0, stdout: 'Result=success\nExecMainStatus=0\nExecMainExitTimestampMonotonic=1234\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  try {
    const result = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run,
    });
    const concurrent = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    concurrent.plugins.other = { version: '1.0.0', enabledFeatures: null, enabled: true };
    concurrent.settings.other = { preserved: true };
    fs.writeFileSync(lockPath, `${JSON.stringify(concurrent)}\n`, { mode: 0o600 });
    fs.chmodSync(lockPath, 0o644);
    await uninstall({ manifestPath: result.manifestPath, run });

    const restored = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.deepEqual(restored.plugins['omp-bounded'], previousEntry);
    assert.deepEqual(restored.settings['omp-bounded'], previousSetting);
    assert.deepEqual(restored.plugins.other, concurrent.plugins.other);
    assert.deepEqual(restored.settings.other, concurrent.settings.other);
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o644);
    assert.equal(fs.realpathSync(linkPath), previousPackage);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('uninstall deletes an installer-owned setting that was previously absent', async () => {
  const f = fixture();
  const lockPath = path.join(f.ompRoot, 'plugins', 'omp-plugins.lock.json');
  const run = (command, args, options) => {
    const result = f.run(command, args, options);
    if (command === fs.realpathSync(f.ompPath) && args[0] === 'plugin' && args[1] === 'link') {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      lock.settings['omp-bounded'] = { mode: 'installed' };
      fs.writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
    }
    return result;
  };
  try {
    const installed = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run,
    });
    const concurrent = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    concurrent.plugins.other = { version: '1.0.0', enabledFeatures: null, enabled: true };
    concurrent.settings.other = { preserved: true };
    fs.writeFileSync(lockPath, `${JSON.stringify(concurrent)}\n`, { mode: 0o600 });
    await uninstall({ manifestPath: installed.manifestPath, run });
    const restored = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(Object.hasOwn(restored.settings, 'omp-bounded'), false);
    assert.deepEqual(restored.plugins.other, concurrent.plugins.other);
    assert.deepEqual(restored.settings.other, concurrent.settings.other);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('uninstall rejects a replaced installation receipt before cleanup', async () => {
  const f = fixture();
  try {
    const result = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    });
    const receiptPath = path.join(f.stateRoot, 'install-receipt.json');
    const target = path.join(f.home, 'forged-receipt.json');
    fs.writeFileSync(target, '{}\n', { mode: 0o600 });
    fs.rmSync(receiptPath);
    fs.symlinkSync(target, receiptPath);

    await assert.rejects(uninstall({ manifestPath: result.manifestPath, run: f.run }), /receipt.*unsafe/i);
    assert.equal(fs.existsSync(path.join(f.home, '.config/systemd/user/omp-bounded-guard.timer')), true);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('uninstall rejects a broken manifest symlink instead of treating it as absent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-broken-manifest-'));
  try {
    const manifestPath = path.join(home, 'installation.json');
    fs.symlinkSync(path.join(home, 'missing'), manifestPath);
    await assert.rejects(uninstall({ manifestPath, run: () => ({ status: 0 }) }), /symlink|manifest/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('install rolls every touched file back after partial link or systemd failure', async () => {
  for (const failure of ['link', 'daemon-reload', 'enable', 'active', 'reconcile']) {
    const f = fixture();
    try {
      const run = (command, args, options) => {
        const result = f.run(command, args, options);
        const joined = args.join(' ');
        if (failure === 'link' && command === fs.realpathSync(f.ompPath) && args[0] === 'plugin') return { ...result, status: 1 };
        if (failure === 'daemon-reload' && joined === '--user daemon-reload') return { ...result, status: 1 };
        if (failure === 'enable' && joined === '--user enable omp-bounded-guard.timer') return { ...result, status: 1 };
        if (failure === 'active' && joined === '--user is-active omp-bounded-guard.timer') return { status: 0, stdout: 'inactive\n' };
        if (failure === 'reconcile' && joined === '--user start omp-bounded-guard.service') return { status: 1, stdout: '' };
        return result;
      };
      await assert.rejects(install({
        home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
        ompPath: f.ompPath, systemctlPath: f.systemctlPath, run,
      }));
      for (const target of [
        path.join(f.stateRoot, 'installation.json'), path.join(f.stateRoot, 'install-receipt.json'),
        path.join(f.home, '.config/systemd/user/omp-bounded-guard.service'),
        path.join(f.home, '.config/systemd/user/omp-bounded-guard.timer'),
        path.join(f.ompRoot, 'plugins/omp-plugins.lock.json'),
        path.join(f.ompRoot, 'plugins/node_modules/omp-bounded'),
      ]) assert.equal(fs.existsSync(target), false, `${failure}: ${target}`);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('the stable state-root directory lock serializes installers without a lock-file residue', async () => {
  const f = fixture();
  const marker = path.join(f.home, 'holder-ready');
  let holder;
  try {
    holder = spawn('/usr/bin/flock', [
      '-n', f.stateRoot, '/bin/sh', '-c', `/usr/bin/touch '${marker}'; sleep 10`,
    ], { detached: true, stdio: 'ignore' });
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(fs.existsSync(marker), true);
    await assert.rejects(install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    }), /installation lock is held/i);
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'installation.json')), false);
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'install-pending.json')), false);
    assert.equal(fs.existsSync(path.join(f.stateRoot, '.install.lock')), false);
  } finally {
    if (holder) { try { process.kill(-holder.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('a controller state lock blocks install and uninstall before either mutates', async () => {
  const f = fixture();
  let release;
  try {
    const installed = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    });
    let ready;
    const entered = new Promise((resolve) => { ready = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const holding = withStateLock(
      f.config.controller.statePath, f.config.controller.flockPath, process.execPath,
      async () => { ready(); await held; },
    );
    await entered;
    const callsBefore = f.calls.length;
    await assert.rejects(install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    }), /installation lock is held/i);
    await assert.rejects(uninstall({ manifestPath: installed.manifestPath, run: f.run }), /installation lock is held/i);
    assert.equal(f.calls.length, callsBefore);
    assert.equal(fs.existsSync(installed.manifestPath), true);
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'install-pending.json')), false);
    assert.equal(fs.existsSync(`${f.config.controller.statePath}.lock`), false);
    release();
    await holding;
    release = undefined;
    assert.equal((await uninstall({ manifestPath: installed.manifestPath, run: f.run })).status, 'uninstalled');
  } finally {
    release?.();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('reconciliation handoff preserves guards and another transaction on contention or identity drift', async () => {
  for (const mode of ['contention', 'identity']) {
    const f = fixture();
    let holder;
    try {
      const marker = path.join(f.home, `handoff-${mode}`);
      const pending = path.join(f.stateRoot, 'install-pending.json');
      const run = (command, args, options) => {
        const result = f.run(command, args, options);
        if (args.join(' ') !== '--user show omp-bounded-guard.service --property=Result --property=ExecMainStatus --property=ExecMainExitTimestampMonotonic') {
          return result;
        }
        if (mode === 'identity') fs.rmSync(pending);
        else {
          holder = spawn('/usr/bin/flock', [
            '-n', f.stateRoot, '/bin/sh', '-c', `/usr/bin/touch '${marker}'; sleep 10`,
          ], { detached: true, stdio: 'ignore' });
          const deadline = Date.now() + 2_000;
          while (!fs.existsSync(marker) && Date.now() < deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          assert.equal(fs.existsSync(marker), true);
        }
        return result;
      };
      await assert.rejects(install({
        home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
        ompPath: f.ompPath, systemctlPath: f.systemctlPath, run,
      }), mode === 'contention' ? /installation lock is held/i : /pending transaction changed/i);
      assert.equal(f.calls.some(([, args]) => args.join(' ') === '--user disable --now omp-bounded-guard.timer'), false);
      assert.equal(fs.existsSync(path.join(f.stateRoot, 'installation.json')), true);
      if (mode === 'contention') assert.equal(fs.existsSync(pending), true);
    } finally {
      if (holder) { try { process.kill(-holder.pid, 'SIGKILL'); } catch {} }
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  }
});

test('retry recovers a process exit immediately after plugin link', async () => {
  const f = fixture();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    import { install } from ${JSON.stringify(new URL('../../scripts/install.mjs', import.meta.url).href)};
    const p = JSON.parse(process.env.OMP_BOUNDED_TEST_PAYLOAD);
    const run = (command, args) => {
      if (command === fs.realpathSync(p.ompPath) && args[0] === 'plugin' && args[1] === 'link') {
        const plugins = path.join(p.home, '.omp', 'plugins');
        const link = path.join(plugins, 'node_modules', 'omp-bounded');
        fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
        fs.rmSync(link, { force: true });
        fs.symlinkSync(p.packageRoot, link);
        fs.writeFileSync(path.join(plugins, 'omp-plugins.lock.json'), JSON.stringify({
          plugins: { 'omp-bounded': { version: '0.0.0', enabledFeatures: null, enabled: true } }, settings: {},
        }) + '\\n', { mode: 0o600 });
        process.exit(91);
      }
      if (args.join(' ') === '--user is-active omp-bounded-guard.service') return { status: 3, stdout: 'inactive\\n' };
      if (args.includes('is-enabled')) return { status: 1, stdout: 'disabled\\n' };
      if (args.includes('is-active')) return { status: 3, stdout: 'inactive\\n' };
      return { status: 0, stdout: '' };
    };
    await install({ home: p.home, env: {}, packageRoot: p.packageRoot, config: p.config,
      ompPath: p.ompPath, systemctlPath: p.systemctlPath, run });
  `], {
    encoding: 'utf8',
    env: { ...process.env, OMP_BOUNDED_TEST_PAYLOAD: JSON.stringify(f) },
  });
  try {
    assert.equal(child.status, 91, child.stderr);
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'install-pending.json')), true);
    const lockDeadline = Date.now() + 2_000;
    while (spawnSync('/usr/bin/flock', [
      '-n', f.stateRoot, '/usr/bin/true',
    ]).status !== 0 && Date.now() < lockDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(spawnSync('/usr/bin/flock', [
      '-n', f.stateRoot, '/usr/bin/true',
    ]).status, 0);
    const stillEnabled = (command, args, options) => {
      const joined = args.join(' ');
      if (joined === '--user disable --now omp-bounded-guard.timer') return { status: 1, stdout: '' };
      if (joined === '--user is-enabled omp-bounded-guard.timer') return { status: 0, stdout: 'enabled\n' };
      if (joined.includes('is-active')) return { status: 3, stdout: 'inactive\n' };
      return f.run(command, args, options);
    };
    await assert.rejects(install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: stillEnabled,
    }), /cannot recover.*enabled/i);
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'install-pending.json')), true);
    const retried = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    });
    assert.equal((await uninstall({ manifestPath: retried.manifestPath, run: f.run })).status, 'uninstalled');
    for (const target of [
      retried.manifestPath, path.join(f.stateRoot, 'install-receipt.json'), path.join(f.stateRoot, 'install-pending.json'),
      path.join(f.home, '.config/systemd/user/omp-bounded-guard.service'),
      path.join(f.home, '.config/systemd/user/omp-bounded-guard.timer'),
      path.join(f.ompRoot, 'plugins/node_modules/omp-bounded'),
    ]) assert.equal(fs.existsSync(target), false, target);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('retry recovers an uninstall process exit after owned files were restored', async () => {
  const f = fixture();
  try {
    const installed = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { uninstall } from ${JSON.stringify(new URL('../../scripts/uninstall.mjs', import.meta.url).href)};
      const p = JSON.parse(process.env.OMP_BOUNDED_TEST_PAYLOAD);
      let timerActive = true;
      const run = (_command, args) => {
        const joined = args.join(' ');
        if (joined === '--user is-active omp-bounded-guard.service') return { status: 3, stdout: 'inactive\\n' };
        if (joined === '--user disable --now omp-bounded-guard.timer') { timerActive = false; return { status: 0, stdout: '' }; }
        if (args.includes('is-enabled')) return { status: 0, stdout: 'enabled\\n' };
        if (args.includes('is-active')) return { status: timerActive ? 0 : 3, stdout: timerActive ? 'active\\n' : 'inactive\\n' };
        if (joined === '--user daemon-reload') process.exit(92);
        return { status: 0, stdout: '' };
      };
      await uninstall({ manifestPath: p.manifestPath, run });
    `], {
      encoding: 'utf8',
      env: { ...process.env, OMP_BOUNDED_TEST_PAYLOAD: JSON.stringify({ manifestPath: installed.manifestPath }) },
    });
    assert.equal(child.status, 92, child.stderr);
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'install-pending.json')), true);
    assert.equal((await uninstall({ manifestPath: installed.manifestPath, run: f.run })).status, 'uninstalled');
    for (const target of [
      installed.manifestPath, path.join(f.stateRoot, 'install-receipt.json'), path.join(f.stateRoot, 'install-pending.json'),
      path.join(f.home, '.config/systemd/user/omp-bounded-guard.service'),
      path.join(f.home, '.config/systemd/user/omp-bounded-guard.timer'),
      path.join(f.ompRoot, 'plugins/node_modules/omp-bounded'),
    ]) assert.equal(fs.existsSync(target), false, target);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('a process exit after pending removal cannot strand the installer lock', async () => {
  const f = fixture();
  try {
    const installed = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { uninstall } from ${JSON.stringify(new URL('../../scripts/uninstall.mjs', import.meta.url).href)};
      const p = JSON.parse(process.env.OMP_BOUNDED_TEST_PAYLOAD);
      const remove = fs.rmSync;
      fs.rmSync = (target, ...args) => {
        const result = remove(target, ...args);
        if (target === p.pendingPath) process.exit(93);
        return result;
      };
      let timerEnabled = true;
      let timerActive = true;
      const run = (_command, args) => {
        const joined = args.join(' ');
        if (joined === '--user disable --now omp-bounded-guard.timer') {
          timerEnabled = false; timerActive = false;
          return { status: 0, stdout: '' };
        }
        if (joined === '--user is-enabled omp-bounded-guard.timer') {
          return { status: timerEnabled ? 0 : 1, stdout: timerEnabled ? 'enabled\\n' : 'disabled\\n' };
        }
        if (joined === '--user is-active omp-bounded-guard.timer') {
          return { status: timerActive ? 0 : 3, stdout: timerActive ? 'active\\n' : 'inactive\\n' };
        }
        if (joined === '--user is-active omp-bounded-guard.service') return { status: 3, stdout: 'inactive\\n' };
        return { status: 0, stdout: '' };
      };
      await uninstall({ manifestPath: p.manifestPath, run });
    `], {
      encoding: 'utf8', env: { ...process.env, OMP_BOUNDED_TEST_PAYLOAD: JSON.stringify({
        manifestPath: installed.manifestPath,
        pendingPath: path.join(f.stateRoot, 'install-pending.json'),
      }) },
    });
    assert.equal(child.status, 93, child.stderr);
    assert.equal((await uninstall({ manifestPath: installed.manifestPath, run: f.run })).status, 'absent');
    assert.equal(fs.existsSync(path.join(f.stateRoot, '.install.lock')), false);
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'install-pending.json')), false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('uninstall treats disable failure and an active timer as fatal without deleting units', async () => {
  for (const mode of ['disable-failed', 'still-active']) {
    const f = fixture();
    try {
      const installed = await install({
        home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
        ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
      });
      const run = (command, args, options) => {
        const joined = args.join(' ');
        if (mode === 'disable-failed' && joined === '--user disable --now omp-bounded-guard.timer') {
          f.run(command, args, options);
          return { status: 1, stdout: '' };
        }
        if (mode === 'still-active' && joined === '--user is-active omp-bounded-guard.timer') return { status: 0, stdout: 'active\n' };
        return f.run(command, args, options);
      };
      await assert.rejects(uninstall({ manifestPath: installed.manifestPath, run }), /disable|active/i);
      assert.equal(fs.existsSync(path.join(f.home, '.config/systemd/user/omp-bounded-guard.timer')), true);
      assert.equal(fs.existsSync(installed.manifestPath), true);
      if (mode === 'disable-failed') assert.equal(f.calls.filter(([, args]) => args.includes('enable')).length >= 2, true);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('uninstall restores runtime enablement and active state of prior units exactly', async () => {
  const f = fixture();
  const unitDir = path.join(f.home, '.config/systemd/user');
  fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(unitDir, 'omp-bounded-guard.service'), 'prior service\n', { mode: 0o600 });
  fs.writeFileSync(path.join(unitDir, 'omp-bounded-guard.timer'), 'prior timer\n', { mode: 0o600 });
  let installationEnabled = false;
  let timerRunning = false;
  const run = (command, args, options) => {
    const joined = args.join(' ');
    if (!installationEnabled && joined === '--user is-enabled omp-bounded-guard.timer') {
      return { status: 0, stdout: 'enabled-runtime\n' };
    }
    if (!installationEnabled && joined === '--user is-active omp-bounded-guard.timer') {
      return { status: 0, stdout: 'active\n' };
    }
    if (joined === '--user disable --now omp-bounded-guard.timer') timerRunning = false;
    if (joined === '--user start omp-bounded-guard.timer') timerRunning = true;
    if (installationEnabled && joined === '--user is-active omp-bounded-guard.timer') {
      return { status: timerRunning ? 0 : 3, stdout: timerRunning ? 'active\n' : 'inactive\n' };
    }
    const result = f.run(command, args, options);
    if (joined === '--user enable omp-bounded-guard.timer') installationEnabled = true;
    return result;
  };
  try {
    const installed = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run,
    });
    await uninstall({ manifestPath: installed.manifestPath, run });
    assert.equal(f.calls.some(([, args]) => args.join(' ')
      === '--user enable --runtime --now omp-bounded-guard.timer'), true);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('uninstall restores prior unit bytes and refuses to remove a replaced unit', async () => {
  const f = fixture();
  const unitDir = path.join(f.home, '.config/systemd/user');
  fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  const service = path.join(unitDir, 'omp-bounded-guard.service');
  const timer = path.join(unitDir, 'omp-bounded-guard.timer');
  fs.writeFileSync(service, 'prior service\n', { mode: 0o600 });
  fs.writeFileSync(timer, 'prior timer\n', { mode: 0o600 });
  try {
    const installed = await install({
      home: f.home, env: {}, packageRoot: f.packageRoot, config: f.config,
      ompPath: f.ompPath, systemctlPath: f.systemctlPath, run: f.run,
    });
    fs.writeFileSync(service, 'foreign replacement\n', { mode: 0o600 });
    await assert.rejects(uninstall({ manifestPath: installed.manifestPath, run: f.run }), /service bytes/i);
    assert.equal(fs.readFileSync(service, 'utf8'), 'foreign replacement\n');
    fs.writeFileSync(service, fs.readFileSync(path.join(f.packageRoot, 'systemd/omp-bounded-guard.service.in'), 'utf8')
      .replaceAll('@NODE_PATH@', fs.realpathSync(process.execPath))
      .replaceAll('@DOCTOR_PATH@', path.join(f.packageRoot, 'scripts/doctor.mjs'))
      .replaceAll('@MANIFEST_PATH@', installed.manifestPath)
      .replaceAll('@STATE_ROOT@', f.stateRoot));
    await uninstall({ manifestPath: installed.manifestPath, run: f.run });
    assert.equal(fs.readFileSync(service, 'utf8'), 'prior service\n');
    assert.equal(fs.readFileSync(timer, 'utf8'), 'prior timer\n');
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
