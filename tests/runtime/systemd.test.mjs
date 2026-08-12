import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGuard, renderGuardUnits } from '../../plugins/bounded/runtime/src/guard.mjs';

test('renders a self-contained user guard without executing systemctl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-runtime-systemd-'));
  const units = renderGuardUnits({ nodePath: '/usr/bin/node', runtimePath: '/plugin/runtime/bin/bounded-runtime.mjs', stateRoot: `${root}/state` });
  assert.match(units.service, /bounded-runtime\.mjs guard/);
  assert.doesNotMatch(units.service, /@(?:NODE|RUNTIME|STATE)_PATH@/);
  assert.doesNotMatch(`${units.service}\n${units.timer}`, /omp-bounded|oh-my/i);
  const installed = installGuard({ configHome: root, nodePath: '/usr/bin/node', runtimePath: '/plugin/runtime/bin/bounded-runtime.mjs', stateRoot: `${root}/state` });
  assert.equal(fs.lstatSync(installed.servicePath).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(installed.timerPath).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});
