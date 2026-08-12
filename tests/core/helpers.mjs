import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stableSerialize } from '../../core/receipt.mjs';

export const NOW = '2026-08-11T00:00:00.000Z';
export const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const artifactProgram = (entriesExpression, prefix = '') => `${prefix}
const __entries=${entriesExpression};process.stdout.write(Buffer.from('OMPART1\\n'));for(const __entry of __entries){const __path=Buffer.from(__entry.path);const __data=Buffer.isBuffer(__entry.data)?__entry.data:Buffer.from(__entry.data);const __header=Buffer.alloc(12);__header.writeUInt32BE(__path.length,0);__header.writeBigUInt64BE(BigInt(__data.length),4);process.stdout.write(__header);process.stdout.write(__path);process.stdout.write(__data)}process.stdout.write(Buffer.alloc(12));`;
export const worker = Object.freeze({
  command: process.execPath,
  args: ['-e', artifactProgram("[{path:'artifacts/result.txt',data:'x'}]")],
});
export const verifierCommand = Object.freeze({
  command: process.execPath,
  args: ['-e', "const fs=require('fs'),crypto=require('crypto');const job=JSON.parse(fs.readFileSync(process.env.OMP_BOUNDED_JOB,'utf8'));const d=v=>'sha256:'+crypto.createHash('sha256').update(v).digest('hex');if(!job.task?.value||!job.acceptanceCheck?.value||job.task.digest!==d(job.task.value)||job.acceptanceCheck.digest!==d(job.acceptanceCheck.value)||job.contract?.acceptanceCheck?.digest!==job.acceptanceCheck.digest||job.policy?.externalEffects?.enabled!==false)process.exit(2);console.log(JSON.stringify({schema:'omp-independent-verification/v1',passed:true,contractDigest:job.contractDigest,artifactDigest:job.artifactDigest,verdict:'CLEAN',findings:[],objectives:Object.fromEntries(job.outputPaths.map(path=>[path,true]))}))"],
});
export const runtimeMounts = Object.freeze([
  { source: '/usr', target: '/usr' },
  { source: fs.realpathSync('/lib'), target: '/lib' },
  ...(fs.existsSync('/lib64') ? [{ source: fs.realpathSync('/lib64'), target: '/lib64' }] : []),
  ...(fs.existsSync('/etc/ld.so.cache') ? [{ source: fs.realpathSync('/etc/ld.so.cache'), target: '/etc/ld.so.cache' }] : []),
].map(Object.freeze));
const executableDigests = new Map();
export const commandDigest = (spec) => {
  const stat = fs.statSync(spec.command, { bigint: true });
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  let executableDigest = executableDigests.get(identity);
  if (!executableDigest) {
    executableDigest = digest(fs.readFileSync(spec.command));
    executableDigests.set(identity, executableDigest);
  }
  return digest(stableSerialize({ command: spec.command, args: spec.args, executableDigest }));
};

export function scopeDigestForRequest(runRequest, evidence) {
  return digest(stableSerialize({
    boundedContext: runRequest.boundedContext,
    writeScope: runRequest.writeScope,
    delivery: runRequest.delivery,
    budgets: runRequest.budgets,
    acceptance: {
      acceptanceCheck: { id: runRequest.acceptanceCheck.id, digest: digest(runRequest.acceptanceCheck.value) },
      requiredGates: [...new Set([...runRequest.requiredGates, 'external-effects-disabled'])],
      retries: runRequest.retries,
      stopPolicy: runRequest.stopPolicy,
      externalEffects: runRequest.externalEffects,
      prohibitedEffects: runRequest.prohibitedEffects,
      maxSeconds: runRequest.maxSeconds,
      phase: runRequest.phase ?? 'dispatch',
      allowFallback: false,
    },
    configDigest: evidence.configDigest,
    runtimeMountsDigest: evidence.runtimeMountsDigest,
    workerCapability: evidence.workerCapability,
    verifierCapability: evidence.verifierCapability,
    nodeDigest: evidence.nodeDigest,
    probeDigest: evidence.probeDigest,
    sourceDigests: evidence.sourceDigests,
  }));
}

export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-core-'));
  const statePath = path.join(root, 'state.json');
  const deliveryRoot = path.join(root, 'delivery');
  const receiptRoot = path.join(deliveryRoot, 'receipts');
  const inputRoot = path.join(root, 'inputs');
  const qualificationRoot = path.join(root, 'qualification');
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(inputRoot, 'input'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(inputRoot, 'sessions'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(inputRoot, 'input/brief.md'), 'bounded brief', { mode: 0o600 });
  fs.writeFileSync(path.join(inputRoot, 'sessions/run.jsonl'), '{"role":"user"}\n', { mode: 0o600 });
  fs.mkdirSync(qualificationRoot, { mode: 0o700 });
  const qualificationPaths = {
    sources: { controller: path.join(qualificationRoot, 'controller.mjs') },
    config: path.join(qualificationRoot, 'config.json'),
    suite: path.join(qualificationRoot, 'suite.json'),
    review: path.join(qualificationRoot, 'review.json'),
    capabilities: path.join(qualificationRoot, 'capabilities.json'),
    probe: path.join(qualificationRoot, 'probe.json'),
    node: path.join(qualificationRoot, 'node.json'),
  };
  fs.writeFileSync(qualificationPaths.sources.controller, 'qualified controller\n', { mode: 0o600 });
  fs.writeFileSync(qualificationPaths.config, 'qualified config\n', { mode: 0o600 });
  const sourceDigests = Object.fromEntries(Object.entries(qualificationPaths.sources)
    .map(([name, file]) => [name, digest(fs.readFileSync(file))]));
  const configDigest = digest(fs.readFileSync(qualificationPaths.config));
  const runtimeMountsDigest = digest(stableSerialize(runtimeMounts));
  const workerCapability = { digest: commandDigest(worker), family: routing().chains.find(({ role }) => role === 'task').family };
  const verifierCapability = { digest: commandDigest(verifierCommand), family: routing().reviewerFamily };
  const nodeDigest = commandDigest({ command: process.execPath, args: [] });
  fs.writeFileSync(qualificationPaths.capabilities, `${JSON.stringify({
    schema: 'omp-capability-qualification/v1',
    runtimeMountsDigest,
    worker: workerCapability,
    verifier: verifierCapability,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(qualificationPaths.node, `${JSON.stringify({
    schema: 'omp-node-qualification/v1',
    nodePath: process.execPath,
    nodeDigest,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(qualificationPaths.probe, `${JSON.stringify({
    schema: 'omp-sandbox-capability-probe/v1', passed: true, workerCapability, verifierCapability,
    nodeDigest, runtimeMountsDigest,
  })}\n`, { mode: 0o600 });
  const probeDigest = digest(fs.readFileSync(qualificationPaths.probe));
  const scopeDigest = scopeDigestForRequest(request(), {
    sourceDigests, configDigest, runtimeMountsDigest, workerCapability, verifierCapability, nodeDigest, probeDigest,
  });
  const subjectDigest = digest(stableSerialize({
    sourceDigests, configDigest, runtimeMountsDigest, workerCapability, verifierCapability, nodeDigest, probeDigest,
  }));
  const contractDigest = digest(stableSerialize({ subjectDigest, scopeDigest }));
  fs.writeFileSync(qualificationPaths.suite, `${JSON.stringify({
    schema: 'omp-qualification-suite/v1', passed: true, subjectDigest, contractDigest, scopeDigest,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(qualificationPaths.review, `${JSON.stringify({
    schema: 'omp-qualification-review/v1', verdict: 'CLEAN', findings: [], subjectDigest,
    contractDigest, scopeDigest, reviewerFamily: routing().reviewerFamily,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(statePath, `${JSON.stringify(baselineState(qualificationPaths), null, 2)}\n`, { mode: 0o600 });
  let now = Date.parse(NOW);
  const calls = [];
  return {
    root,
    statePath,
    receiptRoot,
    inputRoot,
    qualificationPaths,
    deliveryRoot,
    worker,
    verifierCommand,
    bwrapPath: '/usr/bin/bwrap',
    prlimitPath: '/usr/bin/prlimit',
    flockPath: '/usr/bin/flock',
    nodePath: process.execPath,
    runtimeMounts,
    calls,
    clock: () => new Date(now).toISOString(),
    advance: (milliseconds) => { now += milliseconds; },
    executor: Object.assign(async ({ contract, stageRoot }) => {
      calls.push(['execute', contract.runId]);
      const target = path.join(stageRoot, ...contract.delivery.outputPaths[0].split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'x');
      return {
        status: 'completed',
        sandboxed: true,
        writePaths: [...contract.delivery.outputPaths],
        usage: { requests: 1, workers: 1, readBytes: 1, artifactBytes: 1, outputBytes: 1 },
        artifacts: contract.delivery.outputPaths.map((artifactPath) => ({
          path: artifactPath,
          bytes: 1,
          digest: digest(artifactPath),
        })),
      };
    }, { digest: digest('executor-capability') }),
    verifier: Object.assign(async ({ contract }) => {
      calls.push(['verify', contract.runId]);
      return {
        passed: true,
        readOnly: true,
        objectives: Object.fromEntries(contract.delivery.outputPaths.map((item) => [item, true])),
        digest: digest('verification'),
      };
    }, { digest: digest('verifier-capability') }),
    guard: {
      status: async () => ({
        timerActive: true,
        timerEnabled: 'enabled',
        serviceResult: 'success',
        execMainStatus: 0,
        lastReconciled: 1,
        monotonicNow: 1,
        killSwitchActive: true,
        routingReady: true,
        providersReady: true,
        digestsReady: true,
        drift: false,
      }),
      activate: async (contract) => { calls.push(['activate', contract.runId]); },
      rollback: async (reason) => { calls.push(['rollback', reason]); },
      verifyRollback: async () => { calls.push(['verify-rollback']); return true; },
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function qualifyFixture(f, runRequest) {
  const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
  const sourceDigests = Object.fromEntries(Object.entries(f.qualificationPaths.sources)
    .map(([name, file]) => [name, digest(fs.readFileSync(file))]));
  const configDigest = digest(fs.readFileSync(f.qualificationPaths.config));
  const capabilities = JSON.parse(fs.readFileSync(f.qualificationPaths.capabilities, 'utf8'));
  const node = JSON.parse(fs.readFileSync(f.qualificationPaths.node, 'utf8'));
  const probeDigest = digest(fs.readFileSync(f.qualificationPaths.probe));
  const qualification = {
    sourceDigests,
    configDigest,
    runtimeMountsDigest: capabilities.runtimeMountsDigest,
    workerCapability: capabilities.worker,
    verifierCapability: capabilities.verifier,
    nodeDigest: node.nodeDigest,
    probeDigest,
  };
  const scopeDigest = scopeDigestForRequest(runRequest, {
    ...qualification,
  });
  const subjectDigest = digest(stableSerialize(qualification));
  const contractDigest = digest(stableSerialize({ subjectDigest, scopeDigest }));
  fs.writeFileSync(f.qualificationPaths.suite, `${JSON.stringify({
    schema: 'omp-qualification-suite/v1', passed: true, subjectDigest, contractDigest, scopeDigest,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(f.qualificationPaths.review, `${JSON.stringify({
    schema: 'omp-qualification-review/v1', verdict: 'CLEAN', findings: [], subjectDigest,
    contractDigest, scopeDigest, reviewerFamily: runRequest.routing.reviewerFamily,
  })}\n`, { mode: 0o600 });
  state.qualification.sourceDigests = sourceDigests;
  state.qualification.configDigest = configDigest;
  state.qualification.suiteDigest = digest(fs.readFileSync(f.qualificationPaths.suite));
  state.qualification.reviewDigest = digest(fs.readFileSync(f.qualificationPaths.review));
  state.qualification.probeDigest = probeDigest;
  state.qualification.taskDigest = digest(runRequest.task.value);
  state.qualification.scopeDigest = scopeDigest;
  fs.writeFileSync(f.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function baselineState(qualificationPaths) {
  return {
    schema: 'omp-host-trusted-state/v1',
    level: 'L3-narrow-write',
    killSwitch: { active: true, marker: 'UNATTENDED_MODE_DISABLED' },
    qualification: {
      status: 'ready',
      sourceDigests: qualificationPaths
        ? Object.fromEntries(Object.entries(qualificationPaths.sources).map(([name, file]) => [name, digest(fs.readFileSync(file))]))
        : { controller: digest('qualified controller\n') },
      configDigest: qualificationPaths ? digest(fs.readFileSync(qualificationPaths.config)) : digest('qualified config\n'),
      runtimeMountsDigest: digest(stableSerialize(runtimeMounts)),
      suiteDigest: qualificationPaths ? digest(fs.readFileSync(qualificationPaths.suite)) : digest('qualified suite\n'),
      reviewDigest: qualificationPaths ? digest(fs.readFileSync(qualificationPaths.review)) : digest('qualified review\n'),
      probeDigest: qualificationPaths ? digest(fs.readFileSync(qualificationPaths.probe)) : digest('qualified probe\n'),
      workerCapability: { digest: commandDigest(worker), family: routing().chains.find(({ role }) => role === 'task').family },
      verifierCapability: { digest: commandDigest(verifierCommand), family: routing().reviewerFamily },
      nodeDigest: commandDigest({ command: process.execPath, args: [] }),
      qualifiedAt: NOW,
      expiresAt: '2026-08-11T00:10:00.000Z',
      taskDigest: digest('write the bounded result'),
      scopeDigest: qualificationPaths ? JSON.parse(fs.readFileSync(qualificationPaths.suite, 'utf8')).scopeDigest : digest('scope'),
    },
    routing: routing(),
  };
}

export function routing() {
  return {
    reviewerFamily: 'anthropic',
    chains: [
      { role: 'task', family: 'openai-codex', selectors: ['openai-codex/gpt-5.6-sol:high'] },
      { role: 'reviewer', family: 'anthropic', selectors: ['anthropic/claude-opus-5:high'] },
    ],
  };
}

export function request(overrides = {}) {
  return {
    toolCallId: 'tool-call-1',
    sessionId: 'session-1',
    trigger: { id: 'bounded-command', value: '/bounded run' },
    task: { id: 'task-1', value: 'write the bounded result' },
    acceptanceCheck: { id: 'acceptance-1', value: 'artifacts/result.txt contains exactly x' },
    boundedContext: { sessionPath: 'sessions/run.jsonl', readPaths: ['input/brief.md'], maxBytes: 1024 },
    writeScope: { paths: ['artifacts/result.txt'], patchPaths: [], maxFiles: 1 },
    verifier: { id: 'independent-verifier', digest: commandDigest(verifierCommand) },
    requiredGates: ['sandbox', 'trusted-state', 'verifier'],
    budgets: {
      maxReadBytes: 1024,
      maxArtifactBytes: 1024,
      maxOutputBytes: 1024,
      maxRequests: 2,
      maxWorkers: 1,
    },
    maxSeconds: 300,
    retries: { request: 0, worker: 0, transport: 0, semantic: 0 },
    stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    delivery: { mode: 'local', outputPaths: ['artifacts/result.txt'] },
    routing: routing(),
    phase: 'dispatch',
    externalEffects: { enabled: false, finalGate: 'human-approval' },
    prohibitedEffects: 'all external effects',
    ...overrides,
  };
}

export function coreOptions(f) {
  return {
    statePath: f.statePath,
    deliveryRoot: f.deliveryRoot,
    inputRoot: f.inputRoot,
    qualificationPaths: f.qualificationPaths,
    clock: f.clock,
    worker: f.worker,
    verifierCommand: f.verifierCommand,
    bwrapPath: f.bwrapPath,
    prlimitPath: f.prlimitPath,
    flockPath: f.flockPath,
    nodePath: f.nodePath,
    runtimeMounts: f.runtimeMounts,
    guard: f.guard,
  };
}
