import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deriveGlobalPaths,
  globalDoctor,
  installGlobal,
  uninstallGlobal,
} from '../../scripts/global-install.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-global-install-'));
  const systemctlPath = path.join(home, 'systemctl');
  const systemctlLog = path.join(home, 'systemctl.log');
  fs.writeFileSync(systemctlPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BOUNDED_SYSTEMCTL_LOG"\ncase "$*" in *" is-enabled "*) echo enabled;; *" is-active "*) echo active;; *" show "*) echo success;; esac\nexit 0\n', { mode: 0o700 });
  const env = {
    PATH: process.env.PATH,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    BOUNDED_SYSTEMCTL_PATH: systemctlPath,
    BOUNDED_SYSTEMCTL_LOG: systemctlLog,
  };
  return { home, env, systemctlPath, systemctlLog, paths: deriveGlobalPaths({ home, env }) };
}

function install(f, options = {}) {
  return installGlobal({ home: f.home, env: f.env, sourceRoot: repoRoot, systemctlPath: f.systemctlPath, ...options });
}

function doctor(f, manifestPath) {
  return globalDoctor({ manifestPath, env: f.env, systemctlPath: f.systemctlPath });
}

function uninstall(f, manifestPath) {
  return uninstallGlobal({ manifestPath, env: f.env, systemctlPath: f.systemctlPath });
}

test('installs a versioned runtime and selected adapters without checkout paths', () => {
  const f = fixture();
  try {
    const result = install(f, {
      adapters: ['agent-plugins', 'codex', 'claude', 'omp-ohmy-pi'],
    });

    assert.equal(result.status, 'installed');
    assert.equal(fs.lstatSync(f.paths.current).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(f.paths.current), result.paths.versionRoot);
    assert.equal(fs.statSync(result.paths.launcher).mode & 0o111, 0o111);
    assert.ok(fs.existsSync(path.join(result.paths.versionRoot, 'runtime', 'bin', 'bounded.mjs')));
    assert.ok(fs.existsSync(path.join(result.paths.versionRoot, 'adapters', 'agent-plugins', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(result.paths.versionRoot, 'adapters', 'codex', '.codex-plugin', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(result.paths.versionRoot, 'adapters', 'claude', '.claude-plugin', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(result.paths.versionRoot, 'adapters', 'omp-ohmy-pi', 'bounded-hook.mjs')));
    assert.ok(fs.existsSync(result.paths.guardService));
    assert.ok(fs.existsSync(result.paths.guardTimer));
    const installedRuntimePath = path.join(result.paths.current, 'runtime', 'runtime', 'bin', 'bounded-runtime.mjs');
    assert.ok(fs.existsSync(installedRuntimePath));
    assert.match(fs.readFileSync(result.paths.guardService, 'utf8'), new RegExp(installedRuntimePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const systemctlCalls = fs.readFileSync(f.systemctlLog, 'utf8');
    assert.match(systemctlCalls, /--user daemon-reload/);
    assert.match(systemctlCalls, /--user enable --now bounded-runtime-guard\.timer/);
    assert.match(fs.readFileSync(result.paths.guardService, 'utf8'), new RegExp(result.paths.current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.readFileSync(result.paths.guardService, 'utf8').includes(repoRoot), false);

    const manifest = JSON.parse(fs.readFileSync(result.paths.manifest, 'utf8'));
    assert.equal(manifest.schema, 'bounded-global-installation/v1');
    assert.equal(manifest.version, '0.1.1');
    assert.deepEqual(manifest.adapters.map(({ name }) => name), ['agent-plugins', 'codex', 'claude', 'omp-ohmy-pi']);
    assert.equal(JSON.stringify(manifest).includes(repoRoot), false);

    const doctorResult = doctor(f, result.paths.manifest);
    assert.equal(doctorResult.status, 'ready');

    const cli = spawnSync(process.execPath, [result.paths.launcher, 'doctor', '--state-root', result.paths.stateRoot], {
      cwd: f.home,
      env: { ...process.env, ...f.env, BOUNDED_STATE_ROOT: result.paths.stateRoot },
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).status, 'ready');
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('dry-run computes the install without mutating the user root', () => {
  const f = fixture();
  try {
    const result = install(f, {
      adapters: ['agent-plugins'],
      dryRun: true,
    });
    assert.equal(result.status, 'dry-run');
    assert.equal(fs.existsSync(f.paths.manifest), false);
    assert.equal(fs.existsSync(f.paths.launcher), false);
    assert.equal(fs.existsSync(f.paths.dataRoot), false);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('global doctor blocks when the Linux guard timer is not active', () => {
  const f = fixture();
  try {
    const installed = install(f, { adapters: [] });
    fs.writeFileSync(f.systemctlPath, '#!/bin/sh\ncase "$*" in *" is-enabled "*) echo enabled;; *" is-active "*) echo inactive; exit 3;; *" show "*) echo success;; esac\nexit 0\n', { mode: 0o700 });
    assert.throws(() => doctor(f, installed.paths.manifest), /guard timer is inactive/i);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('global doctor blocks when the guard service result is unavailable', () => {
  const f = fixture();
  try {
    const installed = install(f, { adapters: [] });
    fs.writeFileSync(f.systemctlPath, '#!/bin/sh\ncase "$*" in *" is-enabled "*) echo enabled;; *" is-active "*) echo active;; *" show "*) exit 0;; esac\nexit 0\n', { mode: 0o700 });
    assert.throws(() => doctor(f, installed.paths.manifest), /guard service/i);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('failed guard activation disables a partially enabled timer and cleans the install', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.systemctlPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BOUNDED_SYSTEMCTL_LOG"\ncase "$*" in *" enable --now "*) exit 1;; *" is-enabled "*) echo enabled;; *" is-active "*) echo active;; *" show "*) echo success;; esac\nexit 0\n', { mode: 0o700 });
    assert.throws(() => install(f, { adapters: [] }), /systemd user command failed/i);
    const systemctlCalls = fs.readFileSync(f.systemctlLog, 'utf8');
    assert.match(systemctlCalls, /--user disable --now bounded-runtime-guard\.timer/);
    assert.equal(fs.existsSync(f.paths.manifest), false);
    assert.equal(fs.existsSync(f.paths.versionRoot), false);
    assert.equal(fs.existsSync(f.paths.guardService), false);
    assert.equal(fs.existsSync(f.paths.guardTimer), false);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('runtime-only installation contains no adapter packages', () => {
  const f = fixture();
  try {
    const result = install(f, { adapters: [] });
    assert.deepEqual(result.adapters, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.paths.manifest, 'utf8')).adapters, []);
    assert.equal(fs.existsSync(path.join(result.paths.versionRoot, 'adapters')), false);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('macOS install renders a launchd guard and marks containment advisory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-macos-install-'));
  const env = {
    PATH: process.env.PATH,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
  };
  try {
    const paths = deriveGlobalPaths({ home, env, platform: 'darwin' });
    const result = installGlobal({ home, env, sourceRoot: repoRoot, adapters: [], platform: 'darwin' });
    assert.equal(fs.existsSync(paths.launchAgent), true);
    const manifest = JSON.parse(fs.readFileSync(result.paths.manifest, 'utf8'));
    assert.equal(manifest.backend, 'launchd-user-advisory');
    assert.equal(globalDoctor({ manifestPath: result.paths.manifest, env, platform: 'darwin' }).status, 'ready');
    uninstallGlobal({ manifestPath: result.paths.manifest, env, platform: 'darwin' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI supports dry-run, runtime-only, doctor, and adapter listing', () => {
  const f = fixture();
  const cli = path.join(repoRoot, 'scripts', 'bounded.mjs');
  const env = { ...process.env, ...f.env, HOME: f.home };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: f.home, env, encoding: 'utf8' });
  try {
    const dry = run('install', '--user', '--dry-run', '--runtime-only');
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).status, 'dry-run');
    assert.equal(fs.existsSync(f.paths.dataRoot), false);

    const installed = run('install', '--user', '--runtime-only');
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(JSON.parse(run('adapter', 'list').stdout).adapters, []);
    assert.equal(JSON.parse(run('doctor').stdout).status, 'ready');
    assert.equal(run('uninstall').status, 0);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('uninstall removes only the manifest-owned version and launcher', () => {
  const f = fixture();
  try {
    const installed = install(f, {
      adapters: ['agent-plugins'],
    });
    const result = uninstall(f, installed.paths.manifest);
    assert.equal(result.status, 'uninstalled');
    assert.equal(fs.existsSync(installed.paths.manifest), false);
    assert.equal(fs.existsSync(installed.paths.versionRoot), false);
    assert.equal(fs.existsSync(installed.paths.launcher), false);
    assert.equal(fs.existsSync(installed.paths.guardService), false);
    assert.equal(fs.existsSync(installed.paths.guardTimer), false);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test('uninstall refuses a modified owned runtime', () => {
  const f = fixture();
  try {
    const installed = install(f, { adapters: ['agent-plugins'] });
    fs.appendFileSync(path.join(installed.paths.versionRoot, 'runtime', 'README.md'), '\nmodified\n');
    assert.throws(() => uninstall(f, installed.paths.manifest), /digest mismatch/);
    assert.equal(fs.existsSync(installed.paths.versionRoot), true);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
