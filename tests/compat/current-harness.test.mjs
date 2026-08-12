import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.OMP_HARNESS_DIR;
assert.ok(harness, 'OMP_HARNESS_DIR must name the installed harness under test');
assert.ok(path.isAbsolute(harness), 'OMP_HARNESS_DIR must be absolute');
const agentRoot = path.dirname(harness);

const load = (relativePath) => import(pathToFileURL(path.join(harness, relativePath)));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const repeatedDigest = (character) => `sha256:${character.repeat(64)}`;
const NOW = '2026-08-10T18:00:00.000Z';
const packageJson = JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
));
const expectedManifest = packageJson.ompBoundedBaseline.sourceManifest;
const baselineFiles = sourceManifestFiles();
const baselineDigest = manifestDigest(baselineFiles);
assert.equal(baselineFiles.length, expectedManifest.files, 'installed harness file manifest changed');
assert.equal(baselineDigest, expectedManifest.digest, 'installed harness source manifest changed');

const {
  applyPromotion,
  buildL4Candidate,
  createPromotionBundle,
  enterPromotionVerification,
  finalizePromotion,
  materializeL4Candidate,
} = await load('runtime/promotion-controller.mjs');
const observerExtension = await load('runtime/run-observer.mjs');
const { createRunObserver } = observerExtension;
const { validateRunContract } = await load('runtime/run-contract.mjs');
const { appendReceiptEvidence, verifyReceiptLedger } = await load('runtime/evidence-ledger.mjs');
const { bindRunReceipt } = await load('runtime/run-binding.mjs');

test('synthetic registration seam admits through autonomous_run', async () => {
  const fixture = autonomousRunFixture();
  try {
    const result = await fixture.tool.execute(
      'admission-tool-call',
      autonomousRunParams(),
      undefined,
      undefined,
      fixture.context,
    );

    assert.equal(result.isError, false);
    assert.equal(result.details.status, 'delivered');
    assert.equal(fixture.invocation().contract.schema, 'omp-run-contract/v2');
    assert.deepEqual(fixture.invocation().contract.writeScope.paths, ['artifacts/result.txt']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pins the installed harness source manifest', () => {
  assert.equal(packageJson.engines.node, '>=22.22.0 <23');
  assert.equal(packageJson.ompBoundedBaseline.command, 'npm test');
  assert.equal(packageJson.ompBoundedBaseline.cwd, '$OMP_HARNESS_DIR');
  assert.equal(baselineFiles.length, expectedManifest.files);
  assert.equal(baselineDigest, expectedManifest.digest);
  assert.ok(baselineFiles.every((file) => !file.includes('/.git/')));
  assert.ok(baselineFiles.every((file) => !/^runtime\/.*(?:canary|snapshot|receipt|evidence).*\.json$/.test(file)));
  assert.deepEqual(configuredExtensions(), packageJson.ompBoundedBaseline.agentConfig.extensions);
  for (const input of packageJson.ompBoundedBaseline.externalConfigInputs) {
    const filePath = input.path.replace('$HOME', os.homedir());
    assert.equal(digest(fs.readFileSync(filePath)), input.digest, input.path);
  }
});

test('synthetic registration seam rejects autonomous_run scope widening', async () => {
  const fixture = autonomousRunFixture();
  try {
    const params = autonomousRunParams();
    params.admission.writeScope.paths = ['../outside.txt'];
    params.admission.delivery.outputPaths = ['../outside.txt'];

    const result = await fixture.tool.execute(
      'rejected-tool-call',
      params,
      undefined,
      undefined,
      fixture.context,
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.status, 'blocked');
    assert.match(result.details.reason, /write-scope/i);
    assert.equal(fixture.invocation(), undefined);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('extension export blocks direct task execution on a synthetic pi surface', async () => {
  const registrations = new Map();
  const tools = new Map();
  observerExtension.default(fakePi(registrations, tools));
  assert.ok(tools.has('autonomous_run'));

  const result = await registrations.get('tool_call')({
    toolName: 'task',
    toolCallId: 'direct-task',
    input: { task: 'unsafe direct task' },
  }, {});

  assert.equal(result.block, true);
  assert.match(result.reason, /autonomous_run|safety boundary/i);
});

test('expiry restores exact policy, system, trusted-state, and soak baseline bytes', () => {
  const fixture = promotionFixture();
  try {
    activate(fixture);

    const result = runPromotionProcess('reconcile', fixture, fixture.bundle.expiresAt);

    assert.equal(result.status, 'rolled-back');
    assertExactBaseline(fixture);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('explicit rollback restores exact baseline bytes', () => {
  const fixture = promotionFixture();
  try {
    activate(fixture);

    const result = runPromotionProcess('rollback', fixture);

    assert.equal(result.status, 'rolled-back');
    for (const [filePath, content] of Object.entries(fixture.initial)) {
      assert.equal(fs.readFileSync(filePath, 'utf8'), content);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('public receipt binder enforces contract schema and ledger verification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-receipt-'));
  const ledgerPath = path.join(root, 'receipts', 'ledger.jsonl');
  try {
    const contract = receiptContract();
    assert.deepEqual(validateRunContract(contract), { valid: true, findings: [] });
    const receipt = bindRunReceipt(contract, [workerReceipt()], {
      sessionId: 'sensitive-session-id',
      settledAt: '2026-08-10T18:01:00.000Z',
    });
    assert.equal(receipt.schema, 'omp-run-receipt/v1');
    assert.equal(receipt.status, 'ready');
    assert.equal(receipt.runId, contract.runId);
    assert.equal(receipt.toolCallId, contract.toolCallId);
    assert.match(receipt.sessionRef, /^session_[a-f0-9]{24}$/);
    assert.doesNotMatch(JSON.stringify(receipt), /sensitive-session-id/);
    assert.match(receipt.join.digest, /^sha256:[a-f0-9]{64}$/);

    const invalidContract = { ...contract, schema: 'omp-run-contract/unknown' };
    const blocked = bindRunReceipt(invalidContract, [workerReceipt()], { sessionId: 'session' });
    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.findings.some(({ code }) => code === 'contract-schema'));

    const receiptDigest = objectDigest(receipt);
    appendReceiptEvidence(ledgerPath, { receiptDigest }, { now: NOW });
    assert.deepEqual(verifyReceiptLedger(ledgerPath), {
      valid: true,
      entries: 1,
      digest: JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entryDigest,
    });
    fs.writeFileSync(
      ledgerPath,
      fs.readFileSync(ledgerPath, 'utf8').replace(receiptDigest, repeatedDigest('b')),
      { mode: 0o600 },
    );
    assert.equal(verifyReceiptLedger(ledgerPath).valid, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function validContract() {
  return {
    schema: 'omp-run-contract/v2',
    runId: 'run_1234567890abcdef12345678',
    toolCallId: 'tool-call-1',
    trigger: { id: 'trigger-1', digest: repeatedDigest('1') },
    task: { id: 'task-1', digest: repeatedDigest('2') },
    boundedContext: { sessionPath: 'sessions/run.jsonl', readPaths: ['context/brief.json'], maxBytes: 1024 },
    writeScope: { paths: ['artifacts/result.txt'], patchPaths: ['patches/change.patch'] },
    verifier: { id: 'independent-verifier', digest: repeatedDigest('3') },
    requiredGates: ['sandbox', 'trusted-state', 'verifier'],
    budgets: {
      maxReadBytes: 1024,
      maxArtifactBytes: 1024,
      maxOutputBytes: 1024,
      maxRequests: 1,
      maxWorkers: 1,
    },
    deadline: '2026-08-08T00:01:00.000Z',
    retries: { request: 1, worker: 1, transport: 1, semantic: 1 },
    stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    delivery: {
      mode: 'local',
      outputPaths: ['artifacts/result.txt', 'patches/change.patch'],
      receiptPath: 'receipts/run_1234567890abcdef12345678.json',
    },
    routing: {
      reviewerFamily: 'anthropic',
      chains: [
        { role: 'default', family: 'openai-codex', selectors: ['openai-codex/gpt-5.6-terra:high'] },
        { role: 'task', family: 'google-antigravity', selectors: ['google-antigravity/gemini-3.6-flash:high'] },
        { role: 'commit', family: 'ollama-cloud', selectors: ['ollama-cloud/gemma4:31b:low'] },
        { role: 'reviewer', family: 'anthropic', selectors: ['anthropic/claude-opus-5:high'] },
      ],
    },
    trustedStateDigest: repeatedDigest('4'),
    createdAt: '2026-08-08T00:00:00.000Z',
    expiresAt: '2026-08-08T00:05:00.000Z',
    allowFallback: false,
    phase: 'dispatch',
  };
}

function autonomousRunParams() {
  const admission = validContract();
  const now = Date.now();
  admission.createdAt = new Date(now).toISOString();
  admission.deadline = new Date(now + 60_000).toISOString();
  admission.expiresAt = new Date(now + 300_000).toISOString();
  admission.phase = 'review';
  return {
    trigger: 'trusted local trigger',
    task: 'write the bounded local result',
    admission,
  };
}

function autonomousRunFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-observer-'));
  try {
    const deliveryRoot = path.join(root, 'delivery');
    fs.mkdirSync(deliveryRoot, { mode: 0o700 });
    const policy = { schema: 'omp-autonomy/v1', unattended: false, gates: [] };
    const routing = validContract().routing;
    const reviewVerifier = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    const state = {
      schema: 'omp-host-trusted-state/v1',
      hostOwned: true,
      auditedRoot: harness,
      deliveryRoot,
      deliveryManifestTemplate: 'manifests/{runId}.json',
      modelRouting: routing,
      worker: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
      verifier: reviewVerifier,
      reviewVerifier,
      policyDigest: objectDigest(policy),
      policyGates: {},
      killSwitch: { active: true, marker: 'UNATTENDED_MODE_DISABLED' },
    };
    const registrations = new Map();
    const tools = new Map();
    let invocation;
    // OMP 17.2.11 exposes -e but no extension test harness; isolated host loading remains Task 3.
    createRunObserver(fakePi(registrations, tools), {
      loadPolicy: () => policy,
      loadHostState: () => state,
      verifyMcp: () => ({ valid: true }),
      preflight: () => new Date().toISOString(),
      review: async () => ({
        report: `${JSON.stringify({ type: 'summary', verdict: 'CLEAN', findingCount: 0 })}\n`,
        authorProvider: 'google-antigravity',
        reviewerFamily: 'anthropic',
        reviewerSelector: 'anthropic/claude-opus-5:high',
        review: { verdict: 'CLEAN' },
      }),
      execute: async (params) => {
        invocation = params;
        return { status: 'delivered' };
      },
    });
    return {
      root,
      tool: tools.get('autonomous_run'),
      invocation: () => invocation,
      context: {
        sessionManager: {
          getSessionId: () => 'compat-session',
          async saveArtifact() {},
        },
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function receiptContract() {
  return {
    schema: 'omp-run-contract/v1',
    runId: 'run_1234567890abcdef12345678',
    toolCallId: 'receipt-tool-call',
    expectedWorkers: 1,
    minimumSuccessful: 1,
    allowFallback: false,
    createdAt: NOW,
  };
}

function workerReceipt() {
  return {
    workerId: 'worker-1',
    index: 0,
    status: 'success',
    fallback: false,
    artifacts: [{ kind: 'output', ref: repeatedDigest('a'), bytes: 1, verified: true }],
  };
}

function l3Policy() {
  return {
    schema: 'omp-autonomy/v1',
    enabledLevel: 'L3-narrow-write',
    unattended: false,
    narrowWrite: {
      baseDir: agentRoot,
      paths: ['config.yml', 'clean-harness/adapter/skills'],
      maxFiles: 10,
      reversible: true,
    },
    isolation: { mode: 'staging-atomic', mechanism: 'rename-with-backup', worktreeRequiredWhenGit: true },
    reviewer: { independent: true, differentProviderRequired: true },
    gates: [
      { id: 'targeted-test', required: true, phases: ['dispatch', 'review', 'publish'] },
      { id: 'independent-review', required: true, phases: ['publish'] },
      { id: 'human-publish', required: true, phases: ['publish'] },
    ],
    rollback: { command: 'node adapter/honey-adapter.mjs rollback --json', preserves: ['vendor', 'baseline', 'Claude', 'Codex'] },
    killSwitch: { marker: 'UNATTENDED_MODE_DISABLED' },
  };
}

function approval() {
  const scope = { mode: 'single-bounded-run', maxSeconds: 300, externalEffects: false };
  const change = 'Run the exact qualified local OMP task with no external effects.';
  return {
    schema: 'omp-dev-approval/v1',
    approved: true,
    status: 'approved',
    updatedAt: NOW,
    expiresAt: '2026-08-10T18:10:00.000Z',
    requestId: 'dev-20260810T180000Z-1234abcd',
    change,
    scope,
    taskDigest: objectDigest({ change, scope }),
  };
}

function promotionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-bounded-promotion-'));
  try {
    const paths = Object.fromEntries(['policy', 'system', 'state', 'soak', 'status']
      .map((name) => [`${name}Path`, path.join(root, `${name}.json`)]));
    const currentPolicy = l3Policy();
    const currentSystem = '# OMP\nUNATTENDED_MODE_DISABLED\n';
    const currentState = {
      schema: 'omp-host-trusted-state/v1',
      hostOwned: true,
      killSwitch: { active: true, marker: 'UNATTENDED_MODE_DISABLED' },
    };
    const currentSoak = { schema: 'omp-soak/v1', status: 'ready' };
    const authorized = approval();
    // The installed controller still exposes promotion as its narrowest expiry/rollback seam.
    const reviewed = buildL4Candidate({ policy: currentPolicy, approval: authorized, now: NOW });
    const candidatePolicy = materializeL4Candidate({ policy: currentPolicy, candidate: reviewed, approval: authorized, now: NOW });
    const candidatePolicyDigest = objectDigest(candidatePolicy);
    const candidateState = {
      ...currentState,
      policyDigest: candidatePolicyDigest,
      policyGates: Object.fromEntries(['targeted-test', 'independent-review'].map((gate, index) => [gate, {
        status: 'ready',
        digest: repeatedDigest(String(index + 1)),
        sourceDigest: candidatePolicyDigest,
        expiresAt: '2026-08-10T18:05:00.000Z',
      }])),
      promotion: {
        id: authorized.requestId,
        status: 'verified',
        expiresAt: candidatePolicy.promotion.expiresAt,
        taskDigest: authorized.taskDigest,
      },
      killSwitch: { active: false, marker: 'UNATTENDED_MODE_DISABLED' },
    };
    const promotionSoak = {
      schema: 'omp-promotion-soak/v1',
      status: 'ready',
      expiresAt: '2026-08-10T18:05:00.000Z',
      candidatePolicyDigest,
      targetTrustedStateDigest: objectDigest(candidateState),
    };
    const bundle = createPromotionBundle({
      promotionId: 'promotion_1234567890abcdef12345678',
      approval: authorized,
      currentPolicy,
      currentSystem,
      currentState,
      currentSoak,
      candidatePolicy,
      candidateState,
      promotionSoak,
      now: NOW,
    });
    const initial = {
      [paths.policyPath]: json(currentPolicy),
      [paths.systemPath]: currentSystem,
      [paths.statePath]: json(currentState),
      [paths.soakPath]: json(currentSoak),
    };
    for (const [filePath, content] of Object.entries(initial)) fs.writeFileSync(filePath, content, { mode: 0o600 });
    return { root, paths, bundle, initial };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function activate({ bundle, paths }) {
  applyPromotion({ bundle, paths, now: NOW });
  enterPromotionVerification({ bundle, paths });
  finalizePromotion({ bundle, paths, now: NOW });
}

function assertExactBaseline({ initial }) {
  for (const [filePath, content] of Object.entries(initial)) {
    assert.equal(fs.readFileSync(filePath, 'utf8'), content, filePath);
  }
}

function runPromotionProcess(action, fixture, now = undefined) {
  // The installed promotion CLI fixes live paths; a child process keeps this characterization temp-safe.
  const driver = fileURLToPath(new URL('./fixtures/promotion-driver.mjs', import.meta.url));
  const moduleUrl = pathToFileURL(path.join(harness, 'runtime', 'promotion-controller.mjs')).href;
  const result = spawnSync(process.execPath, [driver, moduleUrl], {
    input: JSON.stringify({ action, bundle: fixture.bundle, paths: fixture.paths, now }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function fakePi(registrations, tools) {
  const unknown = () => ({});
  return {
    on(name, handler) { registrations.set(name, handler); },
    events: { on() {} },
    registerTool(tool) { tools.set(tool.name, tool); },
    zod: { object: (shape) => shape, string: unknown, unknown },
    logger: { warn() {} },
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function objectDigest(value) {
  return digest(JSON.stringify(stableValue(value)));
}

function sourceManifestFiles() {
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [path.relative(harness, target)];
  });
  const matchers = new Map([
    ['package.json', /^package\.json$/],
    ['mcp-lock.json', /^mcp-lock\.json$/],
    ['adapter/*.mjs', /^adapter\/[^/]+\.mjs$/],
    ['adapter/pin.json', /^adapter\/pin\.json$/],
    ['adapter/tests/*.test.mjs', /^adapter\/tests\/[^/]+\.test\.mjs$/],
    ['topology/*.mjs', /^topology\/[^/]+\.mjs$/],
    ['topology/omp-topology.json', /^topology\/omp-topology\.json$/],
    ['topology/tests/*.test.mjs', /^topology\/tests\/[^/]+\.test\.mjs$/],
    ['autonomy/*.mjs', /^autonomy\/[^/]+\.mjs$/],
    ['autonomy/policy.json', /^autonomy\/policy\.json$/],
    ['autonomy/tests/*.test.mjs', /^autonomy\/tests\/[^/]+\.test\.mjs$/],
    ['runtime/*.mjs', /^runtime\/[^/]+\.mjs$/],
    ['runtime/run-contract.schema.json', /^runtime\/run-contract\.schema\.json$/],
    ['runtime/fixtures/*.json', /^runtime\/fixtures\/[^/]+\.json$/],
    ['runtime/tests/*.test.mjs', /^runtime\/tests\/[^/]+\.test\.mjs$/],
    ['tests/*.test.mjs', /^tests\/[^/]+\.test\.mjs$/],
  ]);
  const configured = packageJson.ompBoundedBaseline.sourceManifest.allowlist;
  assert.ok(Array.isArray(configured), 'source manifest requires an explicit allowlist');
  assert.ok(configured.every((pattern) => matchers.has(pattern)), 'source manifest contains an unknown allowlist pattern');
  return walk(harness).filter((file) => configured.some((pattern) => matchers.get(pattern).test(file))).sort();
}

function manifestDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(harness, file))).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function configuredExtensions() {
  const configPath = path.resolve(harness, packageJson.ompBoundedBaseline.agentConfig.path);
  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === 'extensions: ' || line === 'extensions:');
  assert.notEqual(start, -1, 'agent config extensions section is missing');
  const values = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+-\s+(.+)$/);
    if (match) values.push(path.relative(agentRoot, match[1]));
  }
  return values;
}
