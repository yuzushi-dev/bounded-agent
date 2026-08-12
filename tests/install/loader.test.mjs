import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createBoundedAutonomyExtension, loadInstallationManifest, loadInstalledComposition, validateInstallationManifest,
} from '../../extensions/bounded-autonomy.mjs';
import { coreOptions, fixture, request } from '../core/helpers.mjs';

function manifestFixture(f) {
  const options = coreOptions(f);
  const { clock, guard, nodePath, ...controller } = options;
  const runRequest = request();
  return {
    manifest: {
      schema: 'omp-bounded-installation/v1',
      packageRoot: path.resolve(new URL('../..', import.meta.url).pathname),
      nodePath,
      ompPath: nodePath,
      ompRoot: path.dirname(f.root),
      pluginsRoot: path.join(f.root, 'plugins'),
      stateRoot: f.root,
      systemdUnitDir: path.join(f.root, 'units'),
      systemctlPath: '/usr/bin/systemctl',
      systemdRunPath: '/usr/bin/systemd-run',
      controller,
      hostAdmissionDefaults: Object.fromEntries([
        'boundedContext', 'verifier', 'requiredGates', 'retries', 'stopPolicy', 'routing', 'phase',
      ].map((name) => [name, runRequest[name]])),
    },
    runRequest,
  };
}

test('installation manifest loading fails closed for absent, symlinked, or unqualified input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-loader-'));
  try {
    const missing = path.join(root, 'missing.json');
    assert.throws(() => loadInstallationManifest(missing), /manifest/i);

    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, '{}\n', { mode: 0o600 });
    const link = path.join(root, 'link.json');
    fs.symlinkSync(target, link);
    assert.throws(() => loadInstallationManifest(link), /symlink/i);

    fs.writeFileSync(target, `${JSON.stringify({ schema: 'omp-bounded-installation/v1' })}\n`, { mode: 0o600 });
    assert.throws(() => loadInstallationManifest(target), /invalid|unqualified/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('default loader forgets a rejected promise so a repaired installation can load', async () => {
  let attempts = 0;
  const lifecycle = [];
  const extension = createBoundedAutonomyExtension({
    loadController: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('installation invalid');
      return {
        controller: Object.fromEntries(['admit', 'discard', 'run', 'status', 'rollback', 'doctor']
          .map((name) => [name, async () => ({ name })])),
        hostAdmissionDefaults: {},
      };
    },
  });
  const pi = {
    registerCommand: (_name, command) => lifecycle.push(command.handler),
    on() {},
  };
  extension(pi);
  const ctx = { ui: { notify() {} } };
  await lifecycle[0]('status', ctx);
  await lifecycle[0]('status', ctx);
  assert.equal(attempts, 2);
});

test('qualified installation manifest composes the live controller, guard, and host defaults', () => {
  const f = fixture();
  try {
    const { manifest, runRequest } = manifestFixture(f);
    const manifestPath = path.join(f.root, 'installation.json');
    fs.mkdirSync(manifest.pluginsRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(manifest.pluginsRoot, 'node_modules'), { mode: 0o700 });
    fs.mkdirSync(manifest.systemdUnitDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const composition = loadInstalledComposition(manifestPath, {
      run: () => ({ status: 0, stdout: 'active\n', stderr: '' }),
    });

    assert.equal(typeof composition.controller.admit, 'function');
    assert.equal(typeof composition.guard.reconcile, 'function');
    assert.deepEqual(composition.hostAdmissionDefaults.routing, runRequest.routing);
  } finally { f.cleanup(); }
});

test('hardened user service composes and reconciles the installed controller', (t) => {
  if (!fs.existsSync('/usr/bin/systemd-run')) return t.skip('systemd-run unavailable');
  if (spawnSync('/usr/bin/systemctl', ['--user', 'show-environment']).status !== 0) {
    return t.skip('user systemd manager unavailable');
  }
  const scratch = fs.mkdtempSync(path.join(os.homedir(), '.omp-bounded-service-'));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const f = fixture();
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  try {
    const { manifest } = manifestFixture(f);
    const manifestPath = path.join(f.root, 'installation.json');
    fs.mkdirSync(manifest.pluginsRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(manifest.pluginsRoot, 'node_modules'), { mode: 0o700 });
    fs.mkdirSync(manifest.systemdUnitDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const unit = `omp-bounded-compose-probe-${process.pid}-${Date.now()}`;
    const result = spawnSync('/usr/bin/systemd-run', [
      '--user', '--wait', '--pipe', '--collect', `--unit=${unit}`,
      '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes',
      '--property=ProtectSystem=strict', '--property=ProtectHome=read-only',
      `--property=ReadWritePaths=${f.root}`,
      process.execPath, path.resolve(new URL('../../scripts/doctor.mjs', import.meta.url).pathname),
      'reconcile', '--manifest', manifestPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"status":"protected"/);
  } finally {
    f.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('installation manifest schema is exact at every nested level and rejects provider credentials', () => {
  const f = fixture();
  try {
    const { manifest } = manifestFixture(f);
    assert.equal(validateInstallationManifest(structuredClone(manifest)).schema, manifest.schema);
    for (const mutate of [
      (value) => { value.hostAdmissionDefaults.routing.extra = true; },
      (value) => { value.hostAdmissionDefaults.routing.chains[0].extra = true; },
      (value) => { value.controller.worker.extra = true; },
      (value) => { value.controller.runtimeMounts[0].extra = true; },
      (value) => { value.controller.statePath = path.join(value.stateRoot, 'nested', 'state.json'); },
      (value) => { value.hostAdmissionDefaults.routing.chains[0].selectors[0] = `ghp_${'a'.repeat(36)}`; },
      (value) => { value.hostAdmissionDefaults.routing.chains[0].selectors[0] = `AIza${'a'.repeat(35)}`; },
      (value) => { value.hostAdmissionDefaults.routing.chains[0].apiKeyRef = 'environment'; },
      (value) => { value.controller.worker.args = ['--auth', 'opaque-credential-value']; },
      (value) => { value.controller.worker.args = ['https://user:opaque@example.test/path']; },
      (value) => { value.controller.worker.args = ['--header', 'api-key: 0123456789abcdef0123456789abcdef']; },
      (value) => { value.controller.worker.args = ['--header', 'x-goog-api-key: 0123456789abcdef0123456789abcdef']; },
      (value) => { value.controller.worker.args = ['--header', 'ocp-apim-subscription-key: 0123456789abcdef0123456789abcdef']; },
      (value) => { value.hostAdmissionDefaults.routing.chains[0].privateKey = 'opaque'; },
    ]) {
      const invalid = structuredClone(manifest);
      mutate(invalid);
      assert.throws(() => validateInstallationManifest(invalid), /invalid|credential|unsafe/i);
    }
  } finally { f.cleanup(); }
});
