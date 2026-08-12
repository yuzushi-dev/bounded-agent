import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assembler = path.join(repoRoot, 'packages', 'bounded-agent', 'assemble.mjs');
const npmCommand = process.env.npm_execpath || 'npm';

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
}

function runNpm(args, options = {}) {
  return spawnSync(npmCommand, args, { encoding: 'utf8', ...options });
}

function assemble(destination) {
  const result = runNode([assembler, destination], { cwd: repoRoot });
  assert.equal(result.status, 0, result.stderr);
}

function packageEnvironment(home) {
  return {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_cache: path.join(home, 'npm-cache'),
    npm_config_userconfig: path.join(home, '.npmrc'),
  };
}

function fakeSystemctl(root) {
  const file = path.join(root, 'systemctl');
  fs.writeFileSync(file, `#!/bin/sh
case "$*" in
  *" is-enabled "*) printf 'enabled\\n' ;;
  *" is-active "*) printf 'active\\n' ;;
  *" show "*) printf 'success\\n' ;;
  *) ;;
esac
exit 0
`, { mode: 0o700 });
  return file;
}

test('installs and executes the assembled bounded-agent tarball in an isolated HOME', { timeout: 60_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-agent-install-e2e-'));
  const assembled = path.join(root, 'assembled');
  const prefix = path.join(root, 'consumer');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const env = packageEnvironment(home);
  env.BOUNDED_SYSTEMCTL_PATH = fakeSystemctl(root);
  try {
    assemble(assembled);

    const packed = runNpm(['pack', '--ignore-scripts', '--json'], { cwd: assembled, env });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = path.join(assembled, JSON.parse(packed.stdout)[0].filename);

    const installed = runNpm([
      'install', '--offline', '--ignore-scripts', '--no-package-lock', '--no-save', '--prefix', prefix, tarball,
    ], { cwd: prefix, env });
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

    const installedRoot = path.join(prefix, 'node_modules', 'bounded-agent');
    const installedManifest = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
    assert.deepEqual({ name: installedManifest.name, version: installedManifest.version, license: installedManifest.license }, {
      name: 'bounded-agent', version: '0.1.1', license: 'MIT',
    });
    const cli = path.join(installedRoot, 'scripts', 'bounded.mjs');
    const packageBin = path.join(prefix, 'node_modules', '.bin', 'bounded-agent');
    assert.equal(fs.existsSync(cli), true);
    assert.equal(fs.existsSync(packageBin), true);
    const runPackage = (args) => runNode([packageBin, ...args], { cwd: prefix, env });

    const actualInstall = runPackage(['install']);
    assert.equal(actualInstall.status, 0, `${actualInstall.stdout}\n${actualInstall.stderr}`);
    const installResult = JSON.parse(actualInstall.stdout);
    assert.equal(installResult.status, 'installed');
    assert.deepEqual(installResult.adapters, ['agent-plugins', 'codex', 'claude']);
    for (const target of [
      path.join(home, 'data', 'bounded', '0.1.1', 'runtime', 'bin', 'bounded.mjs'),
      path.join(home, 'data', 'bounded', '0.1.1', 'runtime', 'runtime', 'bin', 'bounded-runtime.mjs'),
      path.join(home, 'data', 'bounded', '0.1.1', 'adapters', 'agent-plugins', 'plugin.json'),
      path.join(home, 'data', 'bounded', '0.1.1', 'adapters', 'claude', '.claude-plugin', 'plugin.json'),
      path.join(home, 'data', 'bounded', '0.1.1', 'adapters', 'codex', '.codex-plugin', 'plugin.json'),
      path.join(home, 'config', 'bounded', 'installation.json'),
      path.join(home, '.local', 'bin', 'bounded-agent'),
    ]) assert.equal(fs.existsSync(target), true, target);

    const launcher = path.join(home, '.local', 'bin', 'bounded-agent');
    const runInstalled = (args) => runNode([launcher, ...args], { cwd: prefix, env });
    const doctor = runInstalled(['doctor']);
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
    assert.equal(JSON.parse(doctor.stdout).status, 'ready');

    const duplicate = runPackage(['install']);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /already exists/);

    const uninstall = runInstalled(['uninstall']);
    assert.equal(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    assert.equal(JSON.parse(uninstall.stdout).status, 'uninstalled');
    assert.equal(fs.existsSync(path.join(home, 'config', 'bounded', 'installation.json')), false);
    assert.equal(fs.existsSync(path.join(home, 'data', 'bounded', '0.1.1')), false);
    assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'bounded-agent')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
