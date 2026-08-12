import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { createController } from '../../core/controller.mjs';
import { createSystemdGuard } from '../../adapters/systemd.mjs';
import { verifyReceipt } from '../../core/receipt.mjs';
import { writeCancellation } from '../../core/state.mjs';
import { artifactProgram, commandDigest, coreOptions, digest, fixture, qualifyFixture, request } from './helpers.mjs';

function controller(f, overrides = {}) {
  const { qualificationRequest = request(), ...controllerOverrides } = overrides;
  if (overrides.worker || overrides.verifierCommand) {
    const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    const capabilities = JSON.parse(fs.readFileSync(f.qualificationPaths.capabilities, 'utf8'));
    if (overrides.worker) {
      state.qualification.workerCapability.digest = commandDigest(overrides.worker);
      capabilities.worker.digest = commandDigest(overrides.worker);
    }
    if (overrides.verifierCommand) {
      state.qualification.verifierCapability.digest = commandDigest(overrides.verifierCommand);
      capabilities.verifier.digest = commandDigest(overrides.verifierCommand);
    }
    fs.writeFileSync(f.qualificationPaths.capabilities, `${JSON.stringify(capabilities)}\n`, { mode: 0o600 });
    const node = JSON.parse(fs.readFileSync(f.qualificationPaths.node, 'utf8'));
    fs.writeFileSync(f.qualificationPaths.probe, `${JSON.stringify({
      schema: 'omp-sandbox-capability-probe/v1',
      passed: true,
      workerCapability: capabilities.worker,
      verifierCapability: capabilities.verifier,
      nodeDigest: node.nodeDigest,
      runtimeMountsDigest: capabilities.runtimeMountsDigest,
    })}\n`, { mode: 0o600 });
    state.qualification.probeDigest = digest(fs.readFileSync(f.qualificationPaths.probe));
    fs.writeFileSync(f.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    qualifyFixture(f, qualificationRequest);
  }
  return createController({ ...coreOptions(f), ...controllerOverrides });
}

test('run executes only a contract admitted by this controller and restores exact L3 bytes', async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.statePath, 'utf8');
    const core = controller(f);
    const contract = await core.admit(request());
    const receipt = await core.run(contract);

    assert.equal(receipt.schema, 'omp-run-receipt/v2');
    assert.equal(receipt.status, 'delivered');
    assert.equal(receipt.contractDigest.startsWith('sha256:'), true);
    assert.equal(receipt.budgetUsage.requests, 2);
    assert.equal(f.calls[0][0], 'activate');
    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'completed'));
    assert.ok(f.calls.some(([name]) => name === 'verify-rollback'));
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), before);
    assert.equal(fs.readFileSync(`${f.deliveryRoot}/artifacts/result.txt`, 'utf8'), 'x');
    assert.deepEqual(JSON.parse(fs.readFileSync(`${f.receiptRoot}/${contract.runId}.json`, 'utf8')), receipt);

    await assert.rejects(core.run(contract), /not admitted|already consumed/i);
    const other = controller(f);
    const foreign = await other.admit(request({ toolCallId: 'foreign' }));
    await assert.rejects(core.run(foreign), /not admitted/i);
  } finally { f.cleanup(); }
});

test('discard revokes an admitted contract without activation and is idempotent', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    const contract = await core.admit(request());

    assert.deepEqual(await core.discard(contract), { status: 'discarded', runId: contract.runId });
    assert.deepEqual(await core.discard(contract), { status: 'absent', runId: contract.runId });
    await assert.rejects(core.run(contract), /not admitted|already consumed/i);
    assert.equal(f.calls.some(([name]) => name === 'activate'), false);
  } finally { f.cleanup(); }
});

test('run abort kills active sandbox execution and rolls back to exact L3 bytes', async () => {
  const f = fixture();
  try {
    const abort = new AbortController();
    const worker = command("process.stderr.write('started');setTimeout(()=>process.exit(3),1500)");
    const guard = {
      ...f.guard,
      activate: async (contract) => {
        await f.guard.activate(contract);
        setTimeout(() => abort.abort(new Error('operator cancelled')), 100);
      },
    };
    const core = controller(f, { worker, guard });
    const contract = await core.admit(request());
    const before = fs.readFileSync(f.statePath, 'utf8');
    const startedAt = Date.now();

    await assert.rejects(core.run(contract, { signal: abort.signal }), /operator cancelled/);

    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), before);
    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'failed'));
    assert.equal(fs.existsSync(`${f.deliveryRoot}/artifacts/result.txt`), false);
  } finally { f.cleanup(); }
});

test('run honors only its own durable expiry cancellation before spawning work', async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.statePath, 'utf8');
    const guard = {
      ...f.guard,
      activate: async (contract) => {
        await f.guard.activate(contract);
        writeCancellation(f.statePath, contract.runId);
      },
    };
    const core = controller(f, { guard });
    const contract = await core.admit(request());

    await assert.rejects(core.run(contract), /bounded execution expired/i);

    assert.equal(fs.readFileSync(f.statePath, 'utf8'), before);
    assert.equal(f.calls.some(([name]) => name === 'execute'), false);
    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'failed'));
  } finally { f.cleanup(); }
});

test('run preserves a pre-existing run-bound scratch collision', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    const contract = await core.admit(request());
    const stage = path.join(f.receiptRoot, `.stage-${contract.runId}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.writeFileSync(path.join(stage, 'host-owned'), 'keep', { mode: 0o600 });

    await assert.rejects(core.run(contract), /scratch path already exists/i);

    assert.equal(fs.readFileSync(path.join(stage, 'host-owned'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(f.receiptRoot, `.job-${contract.runId}`)), false);
  } finally { f.cleanup(); }
});

test('guard retry cleans scratch after a process dies before or between mkdir calls', async () => {
  const helpersPath = path.resolve(new URL('./helpers.mjs', import.meta.url).pathname);
  for (const mode of ['before-first', 'between']) {
    const marker = path.join(fs.mkdtempSync(path.join('/tmp', 'omp-bounded-crash-')), `${mode}.json`);
    const source = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { fileURLToPath } from 'node:url';
      const { fixture, coreOptions, request } = await import(${JSON.stringify(`file://${helpersPath}`)});
      const f = fixture();
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ root: f.root, statePath: f.statePath, receiptRoot: f.receiptRoot }));
      const original = fs.mkdirSync;
      fs.mkdirSync = (target, options) => {
        if (path.basename(target).startsWith('.stage-')) {
          if (${JSON.stringify(mode)} === 'before-first') process.kill(process.pid, 'SIGKILL');
          const result = original(target, options);
          if (${JSON.stringify(mode)} === 'between') process.kill(process.pid, 'SIGKILL');
          return result;
        }
        return original(target, options);
      };
      const core = (await import(${JSON.stringify(`file://${path.resolve(new URL('../../core/controller.mjs', import.meta.url).pathname)}`)})).createController(coreOptions(f));
      await core.run(await core.admit(request()));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: 'ignore', detached: true,
    });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(signal === 'SIGKILL' ? -9 : code));
    });
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    let lockReleased = false;
    for (let attempt = 0; attempt < 100 && !lockReleased; attempt += 1) {
      const probe = spawn('/usr/bin/flock', ['-n', JSON.parse(fs.readFileSync(marker, 'utf8')).root, '/usr/bin/true'], {
        stdio: 'ignore',
      });
      const probeExit = await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.once('exit', (code) => resolve(code));
      });
      lockReleased = probeExit === 0;
      if (!lockReleased) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(lockReleased, true, 'crash child lock was not released');
    try {
      assert.equal(exitCode, -9, mode);
      const paths = JSON.parse(fs.readFileSync(marker, 'utf8'));
      const recovery = JSON.parse(fs.readFileSync(`${paths.statePath}.recovery`, 'utf8'));
      const unrelated = path.join(paths.receiptRoot, `${recovery.scratch.stage}-host-owned`);
      fs.mkdirSync(unrelated, { mode: 0o700 });
      fs.writeFileSync(path.join(unrelated, 'keep'), 'host-owned', { mode: 0o600 });
      const guard = createSystemdGuard({
        statePath: paths.statePath,
        stateRoot: paths.root,
        deliveryRoot: paths.receiptRoot,
        systemctlPath: '/usr/bin/systemctl',
        systemdRunPath: '/usr/bin/systemd-run',
        nodePath: process.execPath,
        flockPath: '/usr/bin/flock',
        run: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      assert.equal((await guard.reconcile()).status, 'protected', mode);
      assert.equal(fs.existsSync(path.join(paths.receiptRoot, recovery.scratch.stage)), false, mode);
      assert.equal(fs.existsSync(path.join(paths.receiptRoot, recovery.scratch.job)), false, mode);
      assert.equal(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8'), 'host-owned', mode);
      assert.deepEqual(await guard.reconcile(), { status: 'protected', reason: 'idle' });
    } finally {
      fs.rmSync(JSON.parse(fs.readFileSync(marker, 'utf8')).root, { recursive: true, force: true });
      fs.rmSync(path.dirname(marker), { recursive: true, force: true });
    }
  }
});

test('admission reserves one request each for the worker and independent verifier', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    const insufficient = request({ budgets: { ...request().budgets, maxRequests: 1 } });
    await assert.rejects(core.admit(insufficient), /budget/i);
  } finally { f.cleanup(); }
});

test('activation keeps volatile recovery fields out of host-owned state schema', async () => {
  const f = fixture();
  try {
    const guard = { ...f.guard, activate: async () => {
      const live = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
      assert.equal(Object.hasOwn(live, 'pending'), false);
      assert.equal(Object.hasOwn(live, 'active'), false);
    } };
    const core = controller(f, { guard });
    const contract = await core.admit(request());

    await core.run(contract);
  } finally { f.cleanup(); }
});

test('bubblewrap prevents a qualified worker from writing to the host filesystem', async () => {
  const f = fixture();
  const escaped = `${f.root}-escaped`;
  try {
    const worker = command(artifactProgram("[{path:'artifacts/result.txt',data:'x'}]", `const fs=require('fs');try{fs.writeFileSync(${JSON.stringify(escaped)},'bad')}catch{}`));
    const core = controller(f, { worker });
    const contract = await core.admit(request());

    await core.run(contract);

    assert.equal(fs.existsSync(escaped), false);
  } finally {
    fs.rmSync(escaped, { force: true });
    f.cleanup();
  }
});

test('worker receives an immutable core-owned job and read-only validated inputs', async () => {
  const f = fixture();
  try {
    const worker = command(artifactProgram("[{path:'artifacts/result.txt',data:JSON.stringify({task:job.task.value,acceptanceCheck:job.acceptanceCheck.value,trigger:job.trigger.value,brief,writeScope:job.contract.writeScope,budgets:job.contract.budgets,delivery:job.contract.delivery,gates:job.contract.requiredGates,policy:job.policy})}]", "const fs=require('fs');const job=JSON.parse(fs.readFileSync(process.env.OMP_BOUNDED_JOB,'utf8'));const brief=fs.readFileSync('/inputs/input/brief.md','utf8');try{fs.writeFileSync('/inputs/input/brief.md','changed')}catch{};"));
    const core = controller(f, { worker });
    const contract = await core.admit(request());

    await core.run(contract);

    assert.deepEqual(JSON.parse(fs.readFileSync(`${f.deliveryRoot}/artifacts/result.txt`, 'utf8')), {
      task: 'write the bounded result',
      acceptanceCheck: 'artifacts/result.txt contains exactly x',
      trigger: '/bounded run',
      brief: 'bounded brief',
      writeScope: contract.writeScope,
      budgets: contract.budgets,
      delivery: contract.delivery,
      gates: contract.requiredGates,
      policy: { allowFallback: false, externalEffects: { enabled: false, finalGate: 'human-approval' } },
    });
    assert.equal(fs.readFileSync(`${f.inputRoot}/input/brief.md`, 'utf8'), 'bounded brief');
  } finally { f.cleanup(); }
});

test('sandbox rejects transient aggregate quota excess even when files are truncated before exit', async () => {
  const f = fixture();
  try {
    const worker = command(artifactProgram("[{path:'artifacts/a.txt',data:'x'.repeat(700)},{path:'artifacts/b.txt',data:'x'.repeat(700)},{path:'artifacts/a.txt',data:'x'}]"));
    const scoped = request({
      writeScope: { paths: ['artifacts/a.txt', 'artifacts/b.txt'], patchPaths: [], maxFiles: 2 },
      delivery: { mode: 'local', outputPaths: ['artifacts/a.txt', 'artifacts/b.txt'] },
    });
    qualifyFixture(f, scoped);
    const core = controller(f, { worker, qualificationRequest: scoped });
    const contract = await core.admit(scoped);

    await assert.rejects(core.run(contract), /artifact quota/i);
  } finally { f.cleanup(); }
});

test('artifact protocol rejects malformed, truncated, and duplicate frames', async (t) => {
  for (const [name, source, expected] of [
    ['malformed', "process.stdout.write('not-a-frame')", /sandbox/i],
    ['truncated', "process.stdout.write(Buffer.from('OMPART1\\n'));const h=Buffer.alloc(12);h.writeUInt32BE(20,0);h.writeBigUInt64BE(1n,4);process.stdout.write(h)", /sandbox/i],
    ['duplicate', artifactProgram("[{path:'artifacts/result.txt',data:'x'},{path:'artifacts/result.txt',data:'y'}]"), /write scope/i],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      try {
        const worker = command(source);
        const core = controller(f, { worker });
        const contract = await core.admit(request());
        await assert.rejects(core.run(contract), expected);
      } finally { f.cleanup(); }
    });
  }
});

test('admission freshness is rechecked after asynchronous guard preflight', async () => {
  const f = fixture();
  try {
    const guard = { ...f.guard, status: async () => {
      f.advance(5_001);
      return f.guard.status();
    } };
    const core = controller(f, { guard });
    const contract = await core.admit(request());

    await assert.rejects(core.run(contract), /activation window/i);

    assert.equal(f.calls.some(([name]) => name === 'activate'), false);
  } finally { f.cleanup(); }
});

test('all qualification evidence is revalidated after asynchronous guard preflight', async () => {
  const f = fixture();
  try {
    const guard = { ...f.guard, status: async () => {
      fs.writeFileSync(f.qualificationPaths.review, 'drifted during preflight\n', { mode: 0o600 });
      return f.guard.status();
    } };
    const core = controller(f, { guard });
    const contract = await core.admit(request());

    await assert.rejects(core.run(contract), /qualification|drift/i);

    assert.equal(f.calls.some(([name]) => name === 'activate'), false);
  } finally { f.cleanup(); }
});

test('all qualification evidence is revalidated after guard activation', async () => {
  const f = fixture();
  try {
    const guard = { ...f.guard, activate: async (contract) => {
      f.calls.push(['activate', contract.runId]);
      fs.writeFileSync(f.qualificationPaths.review, 'drifted during activation\n', { mode: 0o600 });
    } };
    const core = controller(f, { guard });
    const contract = await core.admit(request());

    await assert.rejects(core.run(contract), /qualification|drift/i);

    assert.equal(fs.existsSync(`${f.receiptRoot}/${contract.runId}.json`), false);
    assert.ok(f.calls.some(([name]) => name === 'rollback'));
  } finally { f.cleanup(); }
});

test('qualification is revalidated after worker and verifier execution', async (t) => {
  await t.test('worker', async () => {
    const f = fixture();
    try {
      const worker = command(artifactProgram("[{path:'artifacts/result.txt',data:'x'}]", "const until=Date.now()+150;while(Date.now()<until){};"));
      const core = controller(f, { worker });
      const contract = await core.admit(request());
      setTimeout(() => fs.writeFileSync(f.qualificationPaths.sources.controller, 'worker-time drift\n', { mode: 0o600 }), 75);
      await assert.rejects(core.run(contract), /qualification|drift/i);
    } finally { f.cleanup(); }
  });
  await t.test('verifier', async () => {
    const f = fixture();
    try {
      const verifierCommand = command("const fs=require('fs');const job=JSON.parse(fs.readFileSync(process.env.OMP_BOUNDED_JOB,'utf8'));setTimeout(()=>console.log(JSON.stringify({schema:'omp-independent-verification/v1',passed:true,contractDigest:job.contractDigest,artifactDigest:job.artifactDigest,verdict:'CLEAN',findings:[],objectives:Object.fromEntries(job.outputPaths.map(path=>[path,true]))})),200)");
      const core = controller(f, { verifierCommand });
      const contract = await core.admit(request({ verifier: { id: 'independent-verifier', digest: commandDigest(verifierCommand) } }));
      setTimeout(() => fs.writeFileSync(f.qualificationPaths.sources.controller, 'verifier-time drift\n', { mode: 0o600 }), 150);
      await assert.rejects(core.run(contract), /qualification|drift/i);
    } finally { f.cleanup(); }
  });
});

test('verifier report requires exact contract, artifact, family, verdict, findings, and schema bindings', async () => {
  const f = fixture();
  try {
    const verifierCommand = command("const fs=require('fs');const job=JSON.parse(fs.readFileSync(process.env.OMP_BOUNDED_JOB,'utf8'));console.log(JSON.stringify({schema:'omp-independent-verification/v1',passed:true,contractDigest:job.contractDigest,artifactDigest:job.artifactDigest,verifierFamily:job.verifierFamily,verdict:'CLEAN',findings:[],objectives:Object.fromEntries(job.outputPaths.map(path=>[path,true])),extra:true}))");
    const core = controller(f, { verifierCommand });
    const contract = await core.admit(request({ verifier: { id: 'independent-verifier', digest: commandDigest(verifierCommand) } }));

    await assert.rejects(core.run(contract), /verification/i);
  } finally { f.cleanup(); }
});

test('aggregate output quota includes worker logs and verifier evidence', async () => {
  const f = fixture();
  try {
    const worker = command(artifactProgram("[{path:'artifacts/result.txt',data:'x'}]", "console.error('x'.repeat(800));"));
    const core = controller(f, { worker });
    const contract = await core.admit(request());

    await assert.rejects(core.run(contract), /output.*quota|execution quota/i);
  } finally { f.cleanup(); }
});

test('constructor rejects executables outside qualified runtime mounts', async () => {
  const f = fixture();
  try {
    const mutable = path.join(f.root, 'worker-bin');
    fs.copyFileSync('/usr/bin/dash', mutable);
    fs.chmodSync(mutable, 0o755);
    const worker = { command: mutable, args: ['-c', "mkdir -p artifacts; printf x > artifacts/result.txt"] };
    assert.throws(() => controller(f, { worker }), /outside qualified runtime mounts/i);
  } finally { f.cleanup(); }
});

test('delivery failure preserves prior outputs and never publishes a receipt', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(`${f.deliveryRoot}/artifacts`, { mode: 0o700 });
    fs.writeFileSync(`${f.deliveryRoot}/artifacts/result.txt`, 'original');
    const core = controller(f);
    const contract = await core.admit(request());
    const receiptTarget = `${f.receiptRoot}/${contract.runId}.json`;
    fs.mkdirSync(receiptTarget);

    await assert.rejects(core.run(contract), /delivery target/i);

    assert.equal(fs.readFileSync(`${f.deliveryRoot}/artifacts/result.txt`, 'utf8'), 'original');
    assert.equal(fs.lstatSync(receiptTarget).isDirectory(), true);
  } finally { f.cleanup(); }
});

test('delivery preparation failure removes directories created by the transaction', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    const contract = await core.admit(request());
    fs.mkdirSync(`${f.receiptRoot}/${contract.runId}.json`);

    await assert.rejects(core.run(contract), /delivery target/i);

    assert.equal(fs.existsSync(`${f.deliveryRoot}/artifacts`), false);
  } finally { f.cleanup(); }
});

test('transaction failure retains recovery when a journaled directory cannot be removed', async () => {
  const f = fixture();
  const renameSync = fs.renameSync;
  try {
    const core = controller(f);
    const contract = await core.admit(request());
    const blocker = path.join(f.deliveryRoot, 'artifacts/unexpected.txt');
    fs.renameSync = (source, target) => {
      if (path.basename(source) === 'new-0' && target.endsWith('/artifacts/result.txt')) {
        fs.writeFileSync(blocker, 'unexpected');
        throw new Error('injected delivery rename failure');
      }
      return renameSync(source, target);
    };

    await assert.rejects(core.run(contract), /delivery cleanup|recovery remains pending/i);

    assert.equal(fs.existsSync(`${f.statePath}.recovery`), true);
    fs.renameSync = renameSync;
    fs.rmSync(blocker);
    assert.deepEqual(await core.status(), { level: 'L3-narrow-write', active: false, nextDeadline: null });
    assert.equal(fs.existsSync(`${f.statePath}.recovery`), false);
  } finally {
    fs.renameSync = renameSync;
    f.cleanup();
  }
});

test('committed delivery retains recovery until transaction cleanup succeeds', async () => {
  const f = fixture();
  const rmSync = fs.rmSync;
  let rejectTransactionCleanup = true;
  try {
    const core = controller(f);
    const contract = await core.admit(request());
    fs.rmSync = (target, options) => {
      if (rejectTransactionCleanup
        && typeof target === 'string'
        && path.dirname(target) === f.deliveryRoot
        && path.basename(target).startsWith('.omp-run-')
        && options?.recursive === true) {
        throw Object.assign(new Error('injected transaction cleanup failure'), { code: 'EIO' });
      }
      return rmSync(target, options);
    };

    await assert.rejects(core.run(contract), /cleanup/i);

    const receiptTarget = path.join(f.receiptRoot, `${contract.runId}.json`);
    const persistedReceipt = JSON.parse(fs.readFileSync(receiptTarget, 'utf8'));
    assert.equal(fs.readFileSync(path.join(f.deliveryRoot, 'artifacts/result.txt'), 'utf8'), 'x');
    assert.equal(verifyReceipt(persistedReceipt, contract).valid, true);
    assert.equal(fs.existsSync(`${f.statePath}.recovery`), true);
    assert.equal(fs.readdirSync(f.deliveryRoot).some((entry) => entry.startsWith('.omp-run-')), true);

    await assert.rejects(core.status(), /cleanup/i);
    assert.equal(fs.existsSync(`${f.statePath}.recovery`), true);
    assert.equal(fs.readFileSync(path.join(f.deliveryRoot, 'artifacts/result.txt'), 'utf8'), 'x');

    rejectTransactionCleanup = false;
    assert.deepEqual(await core.status(), { level: 'L3-narrow-write', active: false, nextDeadline: null });
    assert.equal(fs.existsSync(`${f.statePath}.recovery`), false);
    assert.equal(fs.readdirSync(f.deliveryRoot).some((entry) => entry.startsWith('.omp-run-')), false);
    assert.equal(fs.readFileSync(path.join(f.deliveryRoot, 'artifacts/result.txt'), 'utf8'), 'x');
    assert.equal(verifyReceipt(JSON.parse(fs.readFileSync(receiptTarget, 'utf8')), contract).valid, true);
  } finally {
    fs.rmSync = rmSync;
    f.cleanup();
  }
});

test('delivery rejects writable pre-existing parent directories', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(`${f.deliveryRoot}/artifacts`, { mode: 0o777 });
    fs.chmodSync(`${f.deliveryRoot}/artifacts`, 0o777);
    const core = controller(f);
    const contract = await core.admit(request());

    await assert.rejects(core.run(contract), /delivery.*directory|permissions/i);

    assert.equal(fs.existsSync(`${f.receiptRoot}/${contract.runId}.json`), false);
  } finally { f.cleanup(); }
});

test('activation receives a fresh full-duration deadline after admission preflight', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    const contract = await core.admit(request());
    f.advance(4_000);

    const receipt = await core.run(contract);

    assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.activatedAt), 300_000);
    assert.equal(Date.parse(receipt.activatedAt) - Date.parse(receipt.admittedAt), 4_000);
  } finally { f.cleanup(); }
});

test('run fails closed and rolls back on scope, quota, sandbox, verifier, lock, and drift failures', async (t) => {
  for (const [name, override, expected] of [
    ['scope', { worker: command(artifactProgram("[{path:'outside.txt',data:'x'}]")) }, /write scope/i],
    ['quota', { worker: command(artifactProgram("[{path:'artifacts/result.txt',data:'x'.repeat(2048)}]")) }, /artifact|sandbox|quota/i],
    ['output-limit', { worker: command(artifactProgram("[{path:'artifacts/result.txt',data:'x'}]", "console.error('x'.repeat(2048));")) }, /sandbox|truncated|output/i],
    ['verifier', { verifierCommand: command("console.log(JSON.stringify({passed:false,objectives:{}}))") }, /verification/i],
    ['drift', { guard: { ...fixtureGuard(), status: async () => ({
      timerActive: true, timerEnabled: 'enabled', serviceResult: 'success', execMainStatus: 0,
      lastReconciled: 1, monotonicNow: 1, killSwitchActive: true,
      routingReady: true, providersReady: true, digestsReady: true, drift: true,
    }) } }, /preflight/i],
    ['guard-health', { guard: { ...fixtureGuard(), status: async () => ({
      timerActive: true, timerEnabled: false, serviceResult: 'failed', execMainStatus: 1,
      lastReconciled: 1, monotonicNow: 120_000_002, killSwitchActive: true,
      routingReady: true, providersReady: true, digestsReady: true, drift: false,
    }) } }, /live preflight failed: .*guard timer is disabled.*guard reconciliation has not succeeded.*guard reconciliation exited unsuccessfully.*guard reconciliation is stale/i],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      try {
        const core = controller(f, override);
        const before = fs.readFileSync(f.statePath, 'utf8');
        const verifier = override.verifierCommand
          ? { id: 'independent-verifier', digest: commandDigest(override.verifierCommand) }
          : request().verifier;
        const contract = await core.admit(request({ toolCallId: `tool-${name}`, verifier }));
        await assert.rejects(core.run(contract), expected);
        assert.equal(fs.readFileSync(f.statePath, 'utf8'), before);
      } finally { f.cleanup(); }
    });
  }

  await t.test('lock', async () => {
    const f = fixture();
    try {
      const core = controller(f);
      const contract = await core.admit(request());
      const holder = await holdLock(f);
      try {
        await assert.rejects(core.run(contract), /lock/i);
      } finally {
        holder.stdin.end();
      }
    } finally { f.cleanup(); }
  });
});

test('live preflight reports every stale guard and readiness field', async () => {
  const f = fixture();
  try {
    const report = {
      timerActive: false, timerEnabled: false, serviceResult: 'failed', execMainStatus: 1,
      lastReconciled: 1, monotonicNow: 120_000_002, killSwitchActive: false,
      routingReady: false, providersReady: false, digestsReady: false, drift: true,
    };
    const core = controller(f, { guard: { ...fixtureGuard(), status: async () => report } });
    const contract = await core.admit(request());
    await assert.rejects(core.run(contract), /live preflight failed: .*guard timer is inactive.*guard timer is disabled.*guard reconciliation has not succeeded.*guard reconciliation exited unsuccessfully.*guard reconciliation is stale.*kill switch is not active.*routing is not ready.*providers are not ready.*qualified digests are not ready.*guard drift detected.*"lastReconciledUs":1.*"monotonicNowUs":120000002.*"reconciliationAgeUs":120000001.*"maxAgeUs":120000000/i);
  } finally { f.cleanup(); }
});

test('status reconciles expiry and pending crash recovery through rollback', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    writeRecoveryFixture(f, baseline, { runId: 'run_1234567890abcdef12345678', expiresAt: NOW });

    const result = await controller(f).status();

    assert.equal(result.level, 'L3-narrow-write');
    assert.equal(result.active, false);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), baseline);
    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'expired'));
  } finally { f.cleanup(); }
});

test('status classifies an interrupted pending activation as crash recovery', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    writeRecoveryFixture(f, baseline);

    await controller(f).status();

    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'crash'));
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), baseline);
  } finally { f.cleanup(); }
});

test('status engages crash recovery before parsing corrupted active state', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    writeRecoveryFixture(f, baseline);
    fs.writeFileSync(f.statePath, '{broken', { mode: 0o600 });

    const result = await controller(f).status();

    assert.equal(result.active, false);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), baseline);
    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'crash'));
  } finally { f.cleanup(); }
});

test('status rolls back active baseline drift even when the external guard misses it', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    writeRecoveryFixture(f, baseline, {
      runId: 'run_1234567890abcdef12345678',
      activatedAt: NOW,
      expiresAt: '2026-08-11T00:01:00.000Z',
      contractDigest: digest('drift'),
    });
    fs.writeFileSync(f.statePath, `${JSON.stringify({ ...JSON.parse(baseline), drift: true })}\n`, { mode: 0o600 });

    const result = await controller(f).status();

    assert.equal(result.active, false);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), baseline);
    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'drift'));
  } finally { f.cleanup(); }
});

test('status fails closed on a malformed active recovery deadline', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    writeRecoveryFixture(f, baseline, {
      runId: 'run_1234567890abcdef12345678',
      activatedAt: NOW,
      expiresAt: 'not-a-date',
      contractDigest: digest('contract'),
    });

    await assert.rejects(controller(f).status(), /recovery/i);
    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'malformed-recovery'));
  } finally { f.cleanup(); }
});

test('status rolls back active qualification drift and doctor recomputes evidence', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    writeRecoveryFixture(f, baseline, {
      expiresAt: '2026-08-11T00:01:00.000Z',
    });
    fs.writeFileSync(f.qualificationPaths.sources.controller, 'active drift\n', { mode: 0o600 });
    const core = controller(f);
    const result = await core.status();
    assert.equal(result.active, false);
    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'qualification-drift'));
    assert.equal((await core.doctor()).status, 'blocked');
  } finally { f.cleanup(); }
});

test('status rolls back a delivery interrupted between atomic renames', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    const transaction = path.join(f.deliveryRoot, '.omp-run-crash');
    fs.mkdirSync(path.join(f.deliveryRoot, 'artifacts'));
    fs.mkdirSync(transaction);
    fs.writeFileSync(path.join(f.deliveryRoot, 'artifacts/result.txt'), 'new');
    fs.writeFileSync(path.join(transaction, 'old-0'), 'original');
    writeRecoveryFixture(f, baseline, null, {
      root: f.deliveryRoot,
      transaction: '.omp-run-crash',
      items: [{
        relative: 'artifacts/result.txt',
        backup: 'old-0',
        hadOriginal: true,
        installing: true,
        installed: true,
      }],
    });

    await controller(f).status();

    assert.equal(fs.readFileSync(path.join(f.deliveryRoot, 'artifacts/result.txt'), 'utf8'), 'original');
    assert.equal(fs.existsSync(transaction), false);
    assert.equal(fs.existsSync(`${f.statePath}.recovery`), false);
  } finally { f.cleanup(); }
});

test('status cleans a delivery crash during journaled preparation', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    const transactionName = '.omp-run-1234567890abcdef12345678-prepare';
    const transaction = path.join(f.deliveryRoot, transactionName);
    const created = path.join(f.deliveryRoot, 'prepared-dir');
    fs.mkdirSync(transaction);
    fs.writeFileSync(path.join(transaction, 'new-0'), 'partial');
    fs.mkdirSync(created);
    writeRecoveryFixture(f, baseline, null, {
      root: f.deliveryRoot,
      transaction: transactionName,
      phase: 'preparing',
      directories: ['prepared-dir'],
      items: [{
        relative: 'artifacts/result.txt', backup: 'old-0', hadOriginal: false, installing: false, installed: false,
      }],
    });

    await controller(f).status();

    assert.equal(fs.existsSync(transaction), false);
    assert.equal(fs.existsSync(created), false);
    assert.equal(fs.existsSync(`${f.statePath}.recovery`), false);
  } finally { f.cleanup(); }
});

test('status retains delivery recovery until every journaled directory is removed', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    const transactionName = '.omp-run-1234567890abcdef12345678-blocked-cleanup';
    const transaction = path.join(f.deliveryRoot, transactionName);
    const created = path.join(f.deliveryRoot, 'prepared-dir');
    const blocker = path.join(created, 'unexpected.txt');
    fs.mkdirSync(transaction);
    fs.mkdirSync(created);
    fs.writeFileSync(blocker, 'unexpected');
    writeRecoveryFixture(f, baseline, null, {
      root: f.deliveryRoot,
      transaction: transactionName,
      phase: 'preparing',
      directories: ['prepared-dir'],
      items: [{
        relative: 'artifacts/result.txt', backup: 'old-0', hadOriginal: false, installing: false, installed: false,
      }],
    });
    const core = controller(f);

    await assert.rejects(core.status(), /delivery cleanup/i);

    assert.equal(fs.existsSync(`${f.statePath}.recovery`), true);
    assert.equal(fs.existsSync(created), true);
    fs.rmSync(blocker);
    assert.deepEqual(await core.status(), { level: 'L3-narrow-write', active: false, nextDeadline: null });
    assert.equal(fs.existsSync(created), false);
    assert.equal(fs.existsSync(`${f.statePath}.recovery`), false);
  } finally { f.cleanup(); }
});

test('kernel lock uses the stable state directory without creating a lock file', async () => {
  const f = fixture();
  try {
    const baseline = fs.readFileSync(f.statePath, 'utf8');
    writeRecoveryFixture(f, baseline);

    const result = await controller(f).status();

    assert.equal(result.active, false);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), baseline);
    assert.equal(fs.existsSync(`${f.statePath}.lock`), false);
  } finally { f.cleanup(); }
});

test('kernel lock rejects an unsafe state directory', async () => {
  const f = fixture();
  try {
    fs.chmodSync(path.dirname(f.statePath), 0o770);
    await assert.rejects(controller(f).status(), /lock directory.*safe|private/i);
    fs.chmodSync(path.dirname(f.statePath), 0o700);
  } finally { f.cleanup(); }
});

test('rollback is idempotent and verifies both independent guards', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    assert.deepEqual(await core.rollback('operator'), { status: 'protected', reason: 'operator' });
    assert.deepEqual(await core.rollback('operator'), { status: 'protected', reason: 'operator' });
    assert.equal(f.calls.filter(([name]) => name === 'rollback').length, 2);
  } finally { f.cleanup(); }
});

test('rollback engages independent guards before parsing corrupted state', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    fs.writeFileSync(f.statePath, '{broken');

    await assert.rejects(core.rollback('corrupt-state'));

    assert.ok(f.calls.some(([name, reason]) => name === 'rollback' && reason === 'corrupt-state'));
  } finally { f.cleanup(); }
});

test('run never publishes a delivered receipt before rollback is verified', async () => {
  const f = fixture();
  try {
    const guard = { ...f.guard, rollback: async () => { throw new Error('guard rollback failed'); } };
    const core = controller(f, { guard });
    const contract = await core.admit(request());

    await assert.rejects(core.run(contract), /guard rollback failed/);

    assert.equal(fs.existsSync(`${f.receiptRoot}/${contract.runId}.json`), false);
  } finally { f.cleanup(); }
});

test('an existing receipt blocks duplicate execution before activation', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    const first = await core.admit(request());
    await core.run(first);
    const calls = f.calls.length;
    const duplicate = await core.admit(request());

    await assert.rejects(core.run(duplicate), /receipt already exists/);

    assert.equal(f.calls.length, calls);
  } finally { f.cleanup(); }
});

test('run rejects a queued contract instead of activating a residual window', async () => {
  const f = fixture();
  try {
    const core = controller(f);
    const contract = await core.admit(request());
    f.advance(5_001);

    await assert.rejects(core.run(contract), /activation window/i);

    assert.equal(f.calls.some(([name]) => name === 'activate'), false);
  } finally { f.cleanup(); }
});

test('doctor reports state, qualification, path, and guard integrity without mutation', async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.statePath, 'utf8');
    const healthy = await controller(f).doctor();
    assert.deepEqual(healthy, {
      status: 'ready', failures: [],
      diagnostics: { lastReconciledUs: 1, monotonicNowUs: 1, reconciliationAgeUs: 0, maxAgeUs: 120_000_000 },
    });
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), before);

    const brokenGuard = { ...f.guard, status: async () => ({
      timerActive: false,
      timerEnabled: false,
      serviceResult: 'failed',
      execMainStatus: 1,
      lastReconciled: null,
      monotonicNow: 1,
      killSwitchActive: false,
      routingReady: false,
      providersReady: false,
      digestsReady: false,
      drift: true,
    }) };
    const broken = await controller(f, { guard: brokenGuard }).doctor();
    assert.equal(broken.status, 'blocked');
    assert.ok(broken.failures.includes('guard timer is inactive'));
    assert.ok(broken.failures.includes('guard timer is disabled'));
    assert.ok(broken.failures.includes('guard reconciliation has not succeeded'));
    assert.ok(broken.failures.includes('guard reconciliation exited unsuccessfully'));
    assert.ok(broken.failures.includes('guard reconciliation is stale'));
    assert.ok(broken.failures.includes('kill switch is not active'));
    assert.ok(broken.failures.includes('routing is not ready'));
    assert.ok(broken.failures.includes('providers are not ready'));
    assert.ok(broken.failures.includes('qualified digests drifted'));
    assert.deepEqual(broken.diagnostics, {
      lastReconciledUs: null, monotonicNowUs: 1, reconciliationAgeUs: null, maxAgeUs: 120_000_000,
    });
  } finally { f.cleanup(); }
});

function fixtureGuard() {
  return {
    status: async () => ({
      timerActive: true, timerEnabled: 'enabled', serviceResult: 'success', execMainStatus: 0,
      lastReconciled: 1, monotonicNow: 1, killSwitchActive: true,
    }),
    activate: async () => {},
    rollback: async () => {},
    verifyRollback: async () => true,
  };
}

const NOW = '2026-08-11T00:00:00.000Z';

function command(source) {
  return { command: process.execPath, args: ['-e', source] };
}

function holdLock(f) {
  const child = spawn(f.flockPath, [
    '-n', path.dirname(f.statePath), process.execPath, '-e',
    "process.stdout.write('LOCKED\\n');process.stdin.resume()",
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(child));
    child.once('error', reject);
  });
}

function writeRecoveryFixture(f, baseline, active = null, delivery = undefined) {
  const normalizedActive = active && {
    runId: 'run_1234567890abcdef12345678',
    activatedAt: '2026-08-10T23:59:00.000Z',
    contractDigest: digest('contract'),
    taskDigest: digest('write the bounded result'),
    scopeDigest: JSON.parse(fs.readFileSync(f.statePath, 'utf8')).qualification.scopeDigest,
    ...active,
  };
  fs.writeFileSync(`${f.statePath}.recovery`, `${JSON.stringify({
    schema: 'omp-bounded-recovery/v1',
    pending: { runId: 'run_1234567890abcdef12345678', baseline, reason: delivery ? 'delivery' : 'activation' },
    active: normalizedActive,
    ...(delivery ? { delivery: { phase: 'prepared', directories: [], ...delivery } } : {}),
  })}\n`, { mode: 0o600 });
}
