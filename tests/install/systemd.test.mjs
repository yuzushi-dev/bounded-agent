import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import { createSystemdGuard, renderGuardService } from '../../adapters/systemd.mjs';

const baseline = () => ({
  schema: 'omp-host-trusted-state/v1',
  level: 'L3-narrow-write',
  killSwitch: { active: true, marker: 'UNATTENDED_MODE_DISABLED' },
  qualification: {},
  routing: {},
});
const pidStartTime = (pid) => {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  } catch { return '0'; }
};

function spawnControllerHolder(root, statePath) {
  const source = `
    const fs = require('node:fs');
    setInterval(() => {
      try {
        const cancellation = JSON.parse(fs.readFileSync(process.env.BOUNDED_STATE + '.cancel', 'utf8'));
        const lease = JSON.parse(fs.readFileSync(process.env.BOUNDED_STATE + '.guard', 'utf8'));
        if (cancellation.runId === lease.runId) process.exit(0);
      } catch {}
    }, 10);
    process.stdout.write(String(process.pid) + '\\n');
  `;
  return spawn('/usr/bin/flock', ['-n', root, process.execPath, '-e', source], {
    env: { ...process.env, BOUNDED_STATE: statePath },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function fixture({ deadlineTimerActive = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-systemd-'));
  fs.chmodSync(root, 0o700);
  const statePath = path.join(root, 'state.json');
  const unitDir = path.join(root, 'units');
  fs.mkdirSync(unitDir, { mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify(baseline())}\n`, { mode: 0o600 });
  const calls = [];
  let deadlineTimerIsActive = deadlineTimerActive;
  const currentMonotonic = Number(process.hrtime.bigint() / 1000n);
  const run = (_command, args) => {
    calls.push(args);
    if (args.join(' ') === '--user is-active omp-bounded-guard.timer') {
      return { status: 0, stdout: 'active\n', stderr: '' };
    }
    if (args.join(' ') === '--user is-enabled omp-bounded-guard.timer') {
      return { status: 0, stdout: 'enabled\n', stderr: '' };
    }
    if (args.join(' ').startsWith('--user is-active omp-bounded-deadline-')) {
      return { status: deadlineTimerIsActive ? 0 : 3, stdout: deadlineTimerIsActive ? 'active\n' : 'inactive\n', stderr: '' };
    }
    if (args.some((item) => /^omp-bounded-deadline-.*\.service$/.test(item))) {
      return { status: 0, stdout: 'LoadState=loaded\nActiveState=active\nResult=success\nExecMainStatus=0\n', stderr: '' };
    }
    if (args.includes('show') && args.some((item) => item.startsWith('omp-bounded-deadline-'))) {
      return { status: 0, stdout: 'AccuracyUSec=1s\nPersistent=yes\n', stderr: '' };
    }
    if (args.includes('show')) {
      return { status: 0, stdout: `Result=success\nExecMainStatus=0\nExecMainExitTimestampMonotonic=${currentMonotonic - 1_000_000}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const guard = createSystemdGuard({
    statePath,
    stateRoot: root,
    unitDir,
    systemctlPath: '/usr/bin/systemctl',
    systemdRunPath: '/usr/bin/systemd-run',
    nodePath: process.execPath,
    flockPath: '/usr/bin/flock',
    run,
  });
  return { calls, guard, root, statePath, setDeadlineTimerActive: (value) => { deadlineTimerIsActive = value; } };
}

test('renders the proven hardened oneshot unit without developer paths', () => {
  const service = renderGuardService({
    nodePath: '/opt/node/bin/node',
    doctorPath: '/opt/omp-bounded/scripts/doctor.mjs',
    manifestPath: '/var/lib/omp-bounded/installation.json',
    stateRoot: '/var/lib/omp-bounded',
  });

  assert.match(service, /Type=oneshot/);
  assert.match(service, /UMask=0077/);
  assert.match(service, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/omp-bounded\/scripts\/doctor\.mjs" reconcile --manifest "\/var\/lib\/omp-bounded\/installation\.json"/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ProtectHome=read-only/);
  assert.match(service, /ReadWritePaths="\/var\/lib\/omp-bounded"/);
  assert.doesNotMatch(service, /\/home\//);
});

test('guard restores the protected baseline after a crash, reboot, or expiry', async () => {
  for (const mode of ['crash', 'reboot', 'expiry']) {
    const f = fixture();
    if (mode === 'expiry') f.setDeadlineTimerActive(false);
    try {
      const original = fs.readFileSync(f.statePath, 'utf8');
      const activeState = { ...baseline(), level: 'L4-bounded', killSwitch: { active: false, marker: 'UNATTENDED_MODE_DISABLED' } };
      fs.writeFileSync(f.statePath, `${JSON.stringify(activeState)}\n`, { mode: 0o600 });
      fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
        schema: 'omp-bounded-recovery/v1',
        pending: { runId: `run_${'a'.repeat(24)}`, baseline: original, reason: 'activation' },
        active: {
          runId: `run_${'a'.repeat(24)}`,
          activatedAt: '2026-08-11T00:00:00.000Z',
          expiresAt: mode === 'expiry' ? '2026-08-11T00:00:01.000Z' : '2026-08-11T00:10:00.000Z',
          contractDigest: `sha256:${'1'.repeat(64)}`,
          taskDigest: `sha256:${'2'.repeat(64)}`,
          scopeDigest: `sha256:${'3'.repeat(64)}`,
        },
      })}\n`, { mode: 0o600 });
      fs.writeFileSync(`${f.statePath}.guard`, `${JSON.stringify({
        schema: 'omp-bounded-guard-lease/v1',
        runId: `run_${'a'.repeat(24)}`,
        deadlineUnit: `omp-bounded-deadline-${'a'.repeat(24)}`,
        workerPid: null,
        workerStartTime: null,
        pid: mode === 'crash' ? 999_999_999 : process.pid,
        pidStartTime: pidStartTime(mode === 'crash' ? 999_999_999 : process.pid),
        bootId: mode === 'reboot' ? 'previous-boot' : 'current-boot',
        expiresAt: mode === 'expiry' ? '2026-08-11T00:00:01.000Z' : '2026-08-11T00:10:00.000Z',
      })}\n`, { mode: 0o600 });
      if (mode === 'expiry') fs.writeFileSync(`${f.statePath}.deadline-pending`, `${JSON.stringify({
        schema: 'omp-bounded-deadline-pending/v1', runId: `run_${'a'.repeat(24)}`,
      })}\n`, { mode: 0o600 });

      const result = await f.guard.reconcile({
        now: '2026-08-11T00:01:00.000Z',
        bootId: 'current-boot',
      });

      assert.equal(result.status, 'protected', mode);
      assert.equal(fs.readFileSync(f.statePath, 'utf8'), original, mode);
      assert.equal(fs.existsSync(`${f.statePath}.recovery`), false, mode);
      assert.equal(fs.existsSync(`${f.statePath}.guard`), false, mode);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('guard removes only active-run scratch paths after crash and preserves collisions', async () => {
  const f = fixture();
  const runId = `run_${'a'.repeat(24)}`;
  const scratchRoot = path.join(f.root, 'delivery', 'receipts');
  const stage = `.stage-${runId}`;
  const job = `.job-${runId}`;
  const unrelated = `.stage-${runId}-host-owned`;
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(scratchRoot, stage), { mode: 0o700 });
  fs.mkdirSync(path.join(scratchRoot, job), { mode: 0o700 });
  fs.mkdirSync(path.join(scratchRoot, unrelated), { mode: 0o700 });
  fs.writeFileSync(path.join(scratchRoot, unrelated, 'keep'), 'host-owned', { mode: 0o600 });
  try {
    const original = fs.readFileSync(f.statePath, 'utf8');
    fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
      schema: 'omp-bounded-recovery/v1',
      pending: { runId, baseline: original, reason: 'activation' },
      active: {
        runId, activatedAt: '2026-08-11T00:00:00.000Z', expiresAt: '2026-08-11T00:10:00.000Z',
        contractDigest: `sha256:${'1'.repeat(64)}`, taskDigest: `sha256:${'2'.repeat(64)}`,
        scopeDigest: `sha256:${'3'.repeat(64)}`,
      },
      scratch: { root: scratchRoot, stage, job },
    })}\n`, { mode: 0o600 });

    assert.deepEqual(await f.guard.reconcile({ now: '2026-08-11T00:01:00.000Z', bootId: 'current-boot' }), {
      status: 'protected', reason: 'crash',
    });
    assert.equal(fs.existsSync(path.join(scratchRoot, stage)), false);
    assert.equal(fs.existsSync(path.join(scratchRoot, job)), false);
    assert.equal(fs.readFileSync(path.join(scratchRoot, unrelated, 'keep'), 'utf8'), 'host-owned');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('expired guard terminates a hung lock holder before restoring L3', async () => {
  const f = fixture({ deadlineTimerActive: false });
  let holder;
  let controllerPid;
  try {
    const original = fs.readFileSync(f.statePath, 'utf8');
    fs.writeFileSync(f.statePath, `${JSON.stringify({
      ...baseline(), level: 'L4-bounded', killSwitch: { active: false, marker: 'UNATTENDED_MODE_DISABLED' },
    })}\n`, { mode: 0o600 });
    const lockPath = path.dirname(f.statePath);
    holder = spawnControllerHolder(lockPath, f.statePath);
    const pid = await new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    });
    controllerPid = pid;
    fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
      schema: 'omp-bounded-recovery/v1',
      pending: { runId: `run_${'a'.repeat(24)}`, baseline: original, reason: 'activation' },
      active: {
        runId: `run_${'a'.repeat(24)}`, activatedAt: '2026-08-11T00:00:00.000Z',
        expiresAt: '2026-08-11T00:00:01.000Z', contractDigest: `sha256:${'1'.repeat(64)}`,
        taskDigest: `sha256:${'2'.repeat(64)}`, scopeDigest: `sha256:${'3'.repeat(64)}`,
      },
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${f.statePath}.guard`, `${JSON.stringify({
      schema: 'omp-bounded-guard-lease/v1', runId: `run_${'a'.repeat(24)}`, pid,
      deadlineUnit: `omp-bounded-deadline-${'a'.repeat(24)}`,
      workerPid: null, workerStartTime: null,
      pidStartTime: pidStartTime(pid), bootId: 'current-boot', expiresAt: '2026-08-11T00:00:01.000Z',
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${f.statePath}.deadline-pending`, `${JSON.stringify({
      schema: 'omp-bounded-deadline-pending/v1', runId: `run_${'a'.repeat(24)}`,
    })}\n`, { mode: 0o600 });
    assert.equal((await f.guard.reconcile({ now: '2026-08-11T00:01:00.000Z', bootId: 'current-boot' })).status, 'protected');
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), original);
  } finally {
    if (controllerPid) { try { process.kill(controllerPid, 'SIGKILL'); } catch {} }
    holder?.kill('SIGKILL');
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('deadline records exact run evidence before reconciling without observing its own service', async () => {
  const f = fixture();
  const runId = `run_${'b'.repeat(24)}`;
  let holder;
  try {
    const original = fs.readFileSync(f.statePath, 'utf8');
    fs.writeFileSync(f.statePath, `${JSON.stringify({
      ...baseline(), level: 'L4-bounded', killSwitch: { active: false, marker: 'UNATTENDED_MODE_DISABLED' },
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
      schema: 'omp-bounded-recovery/v1',
      pending: { runId, baseline: original, reason: 'activation' },
      active: {
        runId, activatedAt: '2026-08-11T00:00:00.000Z', expiresAt: '2026-08-11T00:00:01.000Z',
        contractDigest: `sha256:${'1'.repeat(64)}`, taskDigest: `sha256:${'2'.repeat(64)}`,
        scopeDigest: `sha256:${'3'.repeat(64)}`,
      },
    })}\n`, { mode: 0o600 });
    holder = spawnControllerHolder(f.root, f.statePath);
    const pid = await new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    });
    const deadlineUnit = `omp-bounded-deadline-${runId.slice(4)}`;
    fs.writeFileSync(`${f.statePath}.guard`, `${JSON.stringify({
      schema: 'omp-bounded-guard-lease/v1', runId, pid, pidStartTime: pidStartTime(pid), deadlineUnit,
      workerPid: null, workerStartTime: null,
      bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), expiresAt: '2026-08-11T00:00:01.000Z',
    })}\n`, { mode: 0o600 });
    const result = await f.guard.deadline(runId);
    assert.equal(result.status, 'protected');
    const evidence = JSON.parse(fs.readFileSync(`${f.statePath}.deadline-evidence`, 'utf8'));
    assert.deepEqual(Object.keys(evidence).sort(), ['runId', 'schema', 'source', 'triggerAt']);
    assert.deepEqual(evidence, {
      schema: 'omp-bounded-deadline-evidence/v1', source: 'deadline', runId,
      triggerAt: evidence.triggerAt,
    });
    assert.equal(Number.isFinite(Date.parse(evidence.triggerAt)), true);
    assert.equal(f.calls.some((args) => args.includes(`${deadlineUnit}.service`)
      && args.includes('show')), false);
    assert.equal(f.calls.some((args) => args.includes('omp-bounded-guard.service')
      && args.includes('start')), false);
  } finally {
    if (holder) { try { holder.kill('SIGKILL'); } catch {} }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('deadline rejects a run that is not the exact active lease', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.guard.deadline(`run_${'c'.repeat(24)}`), /active lease/i);
    assert.equal(fs.existsSync(`${f.statePath}.deadline-evidence`), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('normal guard rollback cannot mutate while the shared controller lock is held', async () => {
  const f = fixture();
  let holder;
  try {
    const before = fs.readFileSync(f.statePath, 'utf8');
    holder = spawn('/usr/bin/flock', [
      '-n', f.root, process.execPath, '-e', "process.stdout.write('LOCKED\\n');process.stdin.resume()",
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', resolve);
    });
    await assert.rejects(f.guard.rollback('operator'), /bounded state lock is held/i);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), before);
    assert.equal(fs.existsSync(`${f.statePath}.lock`), false);
  } finally {
    if (holder) {
      holder.stdin.end();
      await new Promise((resolve) => holder.once('exit', resolve));
    }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('guard activation is timer-gated and its status is fail-closed', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
      schema: 'omp-bounded-recovery/v1',
      pending: {
        runId: `run_${'a'.repeat(24)}`,
        baseline: fs.readFileSync(f.statePath, 'utf8'),
        reason: 'activation',
      },
      active: null,
    })}\n`, { mode: 0o600 });
    await f.guard.activate({ runId: `run_${'a'.repeat(24)}`, expiresAt: '2026-08-11T00:05:00.000Z' });
    assert.equal(JSON.parse(fs.readFileSync(`${f.statePath}.guard`, 'utf8')).pid, process.pid);
    assert.equal(f.calls.some((args) => args.includes(`--unit=omp-bounded-deadline-${'a'.repeat(24)}`)
      && args.includes('--timer-property=Persistent=true')
      && args.includes('--on-calendar=2026-08-11 00:05:00 UTC')), true);
    assert.equal(f.calls.some((args) => args.includes('deadline') && args.includes('--run-id')
      && args.includes(`run_${'a'.repeat(24)}`)), true);
    assert.equal(f.calls.some((args) => args.includes('--collect')), true);
    assert.equal(f.calls.some((args) => args.includes('--timer-property=RemainAfterElapse=false')), true);
    assert.equal(f.calls.some((args) => args.includes('--property=RemainAfterExit=true')), false);
    assert.equal(f.calls.some((args) => args.includes('omp-bounded-guard.service') && args.includes('start')), false);
    const report = await f.guard.status();
    assert.equal(report.timerActive, true);
    assert.equal(report.timerEnabled, 'enabled');
    assert.equal(report.serviceResult, 'success');
    assert.equal(report.execMainStatus, 0);
    assert.equal(report.lastReconciledUs, report.lastReconciled);
    assert.equal(report.monotonicNowUs, report.monotonicNow);
    assert.equal(report.reconciliationAgeUs, report.monotonicNowUs - report.lastReconciledUs);
    assert.equal(report.maxAgeUs, 120_000_000);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('expired guard terminates only the bound worker process generation', async () => {
  const f = fixture();
  let worker;
  try {
    const runId = `run_${'a'.repeat(24)}`;
    const original = fs.readFileSync(f.statePath, 'utf8');
    fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
      schema: 'omp-bounded-recovery/v1',
      pending: { runId, baseline: original, reason: 'activation' },
      active: null,
    })}\n`, { mode: 0o600 });
    f.setDeadlineTimerActive(true);
    await f.guard.activate({ runId, expiresAt: '2026-08-11T00:00:01.000Z' });
    worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true, stdio: 'ignore',
    });
    f.guard.bindProcess(runId, worker.pid);
    f.setDeadlineTimerActive(false);
    fs.writeFileSync(`${f.statePath}.deadline-pending`, `${JSON.stringify({
      schema: 'omp-bounded-deadline-pending/v1', runId,
    })}\n`, { mode: 0o600 });
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    assert.equal((await f.guard.reconcile({
      now: '2026-08-11T00:01:00.000Z', bootId: JSON.parse(fs.readFileSync(`${f.statePath}.guard`)).bootId,
    })).status, 'protected');
    await exited;
    assert.equal(fs.existsSync(`${f.statePath}.guard`), false);

    fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
      schema: 'omp-bounded-recovery/v1',
      pending: { runId, baseline: original, reason: 'activation' },
      active: null,
    })}\n`, { mode: 0o600 });
    f.setDeadlineTimerActive(true);
    await f.guard.activate({ runId, expiresAt: '2026-08-11T00:00:01.000Z' });
    worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true, stdio: 'ignore',
    });
    f.guard.bindProcess(runId, worker.pid);
    const stale = JSON.parse(fs.readFileSync(`${f.statePath}.guard`, 'utf8'));
    stale.workerStartTime = String(Number(stale.workerStartTime) + 1);
    fs.writeFileSync(`${f.statePath}.guard`, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    f.setDeadlineTimerActive(false);
    fs.writeFileSync(`${f.statePath}.deadline-pending`, `${JSON.stringify({
      schema: 'omp-bounded-deadline-pending/v1', runId,
    })}\n`, { mode: 0o600 });
    assert.equal((await f.guard.reconcile({
      now: '2026-08-11T00:01:00.000Z', bootId: stale.bootId,
    })).status, 'protected');
    assert.equal(pidStartTime(worker.pid) !== '0', true);
  } finally {
    if (worker) { try { process.kill(-worker.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('stale expiry never signals a later run on the same controller process generation', async () => {
  const f = fixture();
  let controller;
  let controllerPid;
  let worker;
  const originalKill = process.kill;
  const originalRename = fs.renameSync;
  try {
    controller = spawnControllerHolder(f.root, f.statePath);
    controllerPid = await new Promise((resolve, reject) => {
      controller.once('error', reject);
      controller.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    });
    worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    const writeRun = (letter, expiresAt) => {
      const runId = `run_${letter.repeat(24)}`;
      fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
        schema: 'omp-bounded-recovery/v1',
        pending: { runId, baseline: fs.readFileSync(f.statePath, 'utf8'), reason: 'activation' },
        active: {
          runId, activatedAt: '2026-08-11T00:00:00.000Z', expiresAt,
          contractDigest: `sha256:${'1'.repeat(64)}`, taskDigest: `sha256:${'2'.repeat(64)}`,
          scopeDigest: `sha256:${'3'.repeat(64)}`,
        },
      })}\n`, { mode: 0o600 });
      fs.writeFileSync(`${f.statePath}.guard`, `${JSON.stringify({
        schema: 'omp-bounded-guard-lease/v1', runId, pid: controllerPid,
        pidStartTime: pidStartTime(controllerPid), deadlineUnit: `omp-bounded-deadline-${letter.repeat(24)}`,
        workerPid: letter === 'a' ? worker.pid : null,
        workerStartTime: letter === 'a' ? pidStartTime(worker.pid) : null,
        bootId: 'current-boot', expiresAt,
      })}\n`, { mode: 0o600 });
    };
    writeRun('a', '2026-08-11T00:00:01.000Z');
    let switchedAtCancellation = false;
    let staleHostSignal = false;
    fs.renameSync = (source, target) => {
      if (target === `${f.statePath}.cancel` && !switchedAtCancellation) {
        switchedAtCancellation = true;
        writeRun('b', '2026-08-11T00:10:00.000Z');
      }
      originalRename(source, target);
    };
    process.kill = (pid, signal) => {
      if (pid === controllerPid && signal !== 0) staleHostSignal = true;
      return originalKill(pid, signal);
    };
    await assert.rejects(
      f.guard.reconcile({ now: '2026-08-11T00:01:00.000Z', bootId: 'current-boot' }),
      /bounded state lock is held/i,
    );
    assert.equal(switchedAtCancellation, true);
    assert.equal(staleHostSignal, false);
    assert.equal(originalKill(controllerPid, 0), true);
    assert.equal(JSON.parse(fs.readFileSync(`${f.statePath}.guard`, 'utf8')).runId, `run_${'b'.repeat(24)}`);
  } finally {
    fs.renameSync = originalRename;
    process.kill = originalKill;
    if (worker) { try { originalKill(-worker.pid, 'SIGKILL'); } catch {} }
    if (controllerPid) { try { originalKill(controllerPid, 'SIGKILL'); } catch {} }
    if (controller) controller.kill('SIGKILL');
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('guard quarantines malformed recovery and remains recoverable', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(`${f.statePath}.recovery`, '{malformed\n', { mode: 0o600 });
    assert.deepEqual(await f.guard.rollback('timer'), {
      status: 'protected', reason: 'malformed-recovery',
    });
    assert.equal(fs.existsSync(`${f.statePath}.recovery`), false);
    const quarantined = fs.readdirSync(f.root).find((name) => name.startsWith('state.json.recovery.unsafe-'));
    assert.equal(fs.readFileSync(path.join(f.root, quarantined), 'utf8'), '{malformed\n');
    assert.deepEqual(await f.guard.reconcile(), { status: 'protected', reason: 'idle' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('guard never consumes a delivery journal before the controller replays it', async () => {
  const f = fixture();
  try {
    const journal = {
      schema: 'omp-bounded-recovery/v1',
      pending: { runId: `run_${'a'.repeat(24)}`, baseline: fs.readFileSync(f.statePath, 'utf8'), reason: 'delivery' },
      active: null,
      delivery: {
        root: f.root, transaction: '.omp-run-crash', phase: 'preparing', directories: [],
        items: [{ relative: 'result', backup: 'old-0', hadOriginal: false, installing: false, installed: false }],
      },
    };
    fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    assert.deepEqual(await f.guard.rollback('crash'), { status: 'controller-required', reason: 'delivery' });
    assert.deepEqual(JSON.parse(fs.readFileSync(`${f.statePath}.recovery`, 'utf8')), journal);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('invalid-schema and permissive recovery files trigger emergency L3 and can be retried', async () => {
  for (const mode of ['schema', 'permissions']) {
    const f = fixture();
    try {
      fs.writeFileSync(f.statePath, `${JSON.stringify({
        ...baseline(), level: 'L4-bounded', killSwitch: { active: false, marker: 'UNATTENDED_MODE_DISABLED' },
      })}\n`, { mode: 0o600 });
      const recoveryPath = `${f.statePath}.recovery`;
      fs.writeFileSync(recoveryPath, mode === 'schema' ? '{}\n' : `${JSON.stringify({
        schema: 'omp-bounded-recovery/v1',
        pending: { runId: `run_${'a'.repeat(24)}`, baseline: `${JSON.stringify(baseline())}\n`, reason: 'activation' },
        active: null,
      })}\n`, { mode: mode === 'permissions' ? 0o644 : 0o600 });
      if (mode === 'permissions') fs.chmodSync(recoveryPath, 0o644);
      assert.equal((await f.guard.reconcile()).status, 'protected');
      assert.equal(JSON.parse(fs.readFileSync(f.statePath, 'utf8')).killSwitch.active, true);
      assert.equal(fs.existsSync(`${f.statePath}.recovery`), false);
      assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('state.json.recovery.unsafe-')), true);
      assert.equal((await f.guard.reconcile()).status, 'protected');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('guard quarantines unsafe leases and protects an active state', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.statePath, `${JSON.stringify({
      ...baseline(), level: 'L4-bounded', killSwitch: { active: false, marker: 'UNATTENDED_MODE_DISABLED' },
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${f.statePath}.guard`, '{bad\n', { mode: 0o644 });
    const result = await f.guard.reconcile();
    assert.equal(result.status, 'protected');
    assert.equal(JSON.parse(fs.readFileSync(f.statePath, 'utf8')).killSwitch.active, true);
    assert.equal(fs.existsSync(`${f.statePath}.guard`), false);
    assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('state.json.guard.unsafe-')), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('guard quarantines a broken recovery symlink instead of wedging future reconciliation', async () => {
  const f = fixture();
  try {
    fs.symlinkSync(path.join(f.root, 'missing'), `${f.statePath}.recovery`);
    assert.deepEqual(await f.guard.reconcile(), { status: 'protected', reason: 'idle' });
    assert.equal(fs.lstatSync(`${f.statePath}.recovery`, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('state.json.recovery.unsafe-')), true);
    assert.deepEqual(await f.guard.reconcile(), { status: 'protected', reason: 'idle' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('timer uses wall-clock persistence for resume catch-up', () => {
  const timer = fs.readFileSync(new URL('../../systemd/omp-bounded-guard.timer', import.meta.url), 'utf8');
  assert.match(timer, /^OnCalendar=/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^AccuracySec=1s$/m);
  assert.doesNotMatch(timer, /^On(?:Boot|UnitActive)Sec=/m);
});

test('systemd rejects no rendered unit syntax', { skip: !fs.existsSync('/usr/bin/systemd-analyze') }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-unit-'));
  try {
    const servicePath = path.join(root, 'omp-bounded-guard.service');
    const timerPath = path.join(root, 'omp-bounded-guard.timer');
    fs.writeFileSync(servicePath, renderGuardService({
      nodePath: process.execPath,
      doctorPath: path.resolve(new URL('../../scripts/doctor.mjs', import.meta.url).pathname),
      manifestPath: path.join(root, 'installation.json'),
      stateRoot: root,
    }));
    fs.copyFileSync(new URL('../../systemd/omp-bounded-guard.timer', import.meta.url), timerPath);
    const result = requireSpawn('/usr/bin/systemd-analyze', ['--user', 'verify', servicePath, timerPath]);
    assert.equal(result.status, 0, result.stderr);
    const calendar = requireSpawn('/usr/bin/systemd-analyze', ['calendar', '2026-08-11 00:05:00 UTC']);
    assert.equal(calendar.status, 0, calendar.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hardened user service exposes exact FHS runtime mounts as root or overflow-owned', (t) => {
  if (!fs.existsSync('/usr/bin/systemd-run')) return t.skip('systemd-run unavailable');
  const manager = spawnSync('/usr/bin/systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
  if (manager.status !== 0) return t.skip('user systemd manager unavailable');
  const source = `
    const fs = require('node:fs');
    const paths = ['/usr', fs.realpathSync('/lib'),
      ...(fs.existsSync('/lib64') ? [fs.realpathSync('/lib64')] : []),
      ...(fs.existsSync('/etc/ld.so.cache') ? ['/etc/ld.so.cache'] : [])];
    for (const path of paths) {
      const stat = fs.lstatSync(path);
      process.stdout.write(JSON.stringify({ path, uid: stat.uid, mode: stat.mode & 0o777 }) + '\\n');
    }
  `;
  const unit = `omp-bounded-fhs-probe-${process.pid}-${Date.now()}`;
  const result = spawnSync('/usr/bin/systemd-run', [
    '--user', '--wait', '--pipe', '--collect', `--unit=${unit}`,
    '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes',
    '--property=ProtectSystem=strict', '--property=ProtectHome=read-only',
    process.execPath, '-e', source,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const records = result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  assert.ok(records.length >= 2);
  assert.ok(records.every(({ uid }) => uid === 0 || uid === 65534));
  assert.ok(records.every(({ mode }) => (mode & 0o022) === 0));
});

test('systemd exit timestamps share Node hrtime monotonic epoch', (t) => {
  if (!fs.existsSync('/usr/bin/systemd-run')) return t.skip('systemd-run unavailable');
  const manager = spawnSync('/usr/bin/systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
  if (manager.status !== 0) return t.skip('user systemd manager unavailable');
  const unit = `omp-bounded-clock-probe-${process.pid}-${Date.now()}`;
  try {
    const launched = requireSpawn('/usr/bin/systemd-run', [
      '--user', `--unit=${unit}`, '--property=RemainAfterExit=true',
      process.execPath, '-e', 'process.exit(0)',
    ]);
    assert.equal(launched.status, 0, launched.stderr || launched.stdout);
    let properties = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const shown = requireSpawn('/usr/bin/systemctl', ['--user', 'show', unit,
        '--property=LoadState', '--property=ActiveState', '--property=SubState',
        '--property=Result', '--property=ExecMainStatus', '--property=ExecMainExitTimestampMonotonic']);
      if (shown.status === 0) {
        properties = Object.fromEntries(String(shown.stdout).trim().split('\n').filter(Boolean).map((line) => {
          const split = line.indexOf('=');
          return [line.slice(0, split), line.slice(split + 1)];
        }));
        if (properties.SubState === 'exited') break;
      }
      spawnSync('/usr/bin/sleep', ['0.01']);
    }
    assert.equal(properties?.LoadState, 'loaded');
    assert.equal(properties?.ActiveState, 'active');
    assert.equal(properties?.SubState, 'exited');
    assert.equal(properties?.Result, 'success');
    assert.equal(properties?.ExecMainStatus, '0');
    const exitTimestamp = Number(properties?.ExecMainExitTimestampMonotonic);
    const now = Number(process.hrtime.bigint() / 1000n);
    assert.ok(Number.isSafeInteger(exitTimestamp) && exitTimestamp > 0);
    assert.ok(exitTimestamp <= now, `${exitTimestamp} > ${now}`);
    assert.ok(now - exitTimestamp < 120_000_000, `${now - exitTimestamp}`);
  } finally {
    requireSpawn('/usr/bin/systemctl', ['--user', 'stop', unit]);
    requireSpawn('/usr/bin/systemctl', ['--user', 'reset-failed', unit]);
  }
});

function requireSpawn(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

test('unit renderer rejects systemd specifier expansion in paths', () => {
  assert.throws(() => renderGuardService({
    nodePath: '/opt/node%u', doctorPath: '/opt/doctor.mjs', manifestPath: '/opt/install.json', stateRoot: '/opt/state',
  }), /safe absolute path/i);
});
