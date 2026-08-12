import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createContract } from '../../core/contract.mjs';
import { sha256 } from '../../core/receipt.mjs';
import { createCodexAdapter } from './adapters/codex.mjs';
import { createClaudeAdapter } from './adapters/claude.mjs';
import { runSpike } from './run-spike.mjs';

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'CHANGES_REQUIRED'] },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } },
    contractDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    artifactDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    verifierFamily: { type: 'string', enum: ['openai-codex', 'anthropic'] },
  },
  required: ['verdict', 'findings', 'contractDigest', 'artifactDigest', 'verifierFamily'],
};

const ARTIFACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { artifacts: { type: 'array', minItems: 1, maxItems: 1, items: {
    type: 'object', additionalProperties: false,
    properties: { path: { type: 'string', const: 'result.txt' }, content: { type: 'string' } },
    required: ['path', 'content'],
  } } },
  required: ['artifacts'],
};

function command(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  throw new Error(`${name} CLI is unavailable`);
}

function contract(now, lane, variant) {
  const reviewer = lane === 'codex-to-claude' ? 'anthropic' : 'openai-codex';
  const executor = reviewer === 'anthropic' ? 'openai-codex' : 'anthropic';
  return createContract({
    toolCallId: `${lane}-${variant}`, sessionId: 'cross-runtime-spike',
    trigger: { id: 'task8-spike', value: 'host-owned live cross-runtime fixture' },
    task: { id: 'fixture-task', value: 'produce result.txt for independent review' },
    acceptanceCheck: { id: 'exact-safe', value: 'result.txt contains exactly SAFE followed by a newline' },
    boundedContext: { sessionPath: 'fixture/session.jsonl', readPaths: ['brief.md'], maxBytes: 4096 },
    writeScope: { paths: ['result.txt'], patchPaths: [], maxFiles: 1 },
    verifier: { id: `${reviewer}-live-verifier`, digest: sha256(`${reviewer}:2.1.227:0.147.0`) },
    requiredGates: ['sandbox', 'trusted-state', 'verifier'],
    budgets: { maxReadBytes: 4096, maxArtifactBytes: 4096, maxOutputBytes: 262144, maxRequests: 2, maxWorkers: 1 },
    maxSeconds: 300,
    retries: { request: 0, worker: 0, transport: 0, semantic: 0 },
    stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    delivery: { mode: 'local', outputPaths: ['result.txt'] },
    routing: {
      chains: [
        { role: 'task', family: executor, selectors: [`${executor}/local-cli`] },
        { role: 'reviewer', family: reviewer, selectors: [`${reviewer}/local-cli`] },
      ],
      reviewerFamily: reviewer,
    },
  }, { now, trustedStateDigest: sha256('task8-live-fixture') });
}

function roots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-cross-runtime-live-'));
  fs.chmodSync(root, 0o700);
  const baseRoot = path.join(root, 'base');
  const sourceRoot = path.join(root, 'source');
  const deliveryRoot = path.join(root, 'delivery');
  for (const directory of [baseRoot, sourceRoot, deliveryRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(baseRoot, 'result.txt'), 'BASE\n', { mode: 0o600 });
  fs.writeFileSync(path.join(sourceRoot, 'brief.md'),
    'The accepted result.txt contains exactly SAFE followed by one newline. DEFECT is a known failure.\n', { mode: 0o600 });
  return { root, baseRoot, sourceRoot, deliveryRoot };
}

function verifierPrompt() {
  return `Read /scratch/job.json and the audited files under /audit/base, /audit/source, and /audit/stage.
Return only the required JSON object. Copy contractDigest, artifactDigest, and verifierFamily exactly from the envelope.
If /audit/stage/result.txt is exactly SAFE followed by one newline, return CLEAN with no findings.
Otherwise return CHANGES_REQUIRED with exactly one finding: {"code":"known-defect","message":"result.txt is not exactly SAFE\\n"}.`;
}

function commandFor(adapter, spec) {
  if (adapter.family !== 'openai-codex') return { ...spec, debugOutput: true };
  return { ...spec, debugOutput: true, runtimeMounts: [{
    source: path.join(path.dirname(adapter.command), 'codex-code-mode-host'),
    target: '/codex-code-mode-host',
  }] };
}

function executorPrompt() {
  return `Use a filesystem tool now. Write /work/result.txt with exactly the five bytes SAFE followed by one newline.
Then read the file and verify those exact bytes. Do not claim completion unless /work/result.txt exists. Do not create any other file.`;
}

async function lane(name, variant, adapters, credentialFiles) {
  const fixture = roots();
  const now = new Date().toISOString();
  const runContract = contract(now, name, variant);
  const executorFamily = runContract.routing.chains.find(({ role }) => role === 'task').family;
  const verifierFamily = runContract.routing.reviewerFamily;
  const executorAdapter = adapters[executorFamily];
  const verifierAdapter = adapters[verifierFamily];
  const verifierCommand = commandFor(verifierAdapter, verifierFamily === 'openai-codex'
    ? verifierAdapter.buildCommand({ prompt: verifierPrompt(), outputSchema: '/scratch/result-schema.json', lastMessagePath: '/scratch/result.json' })
    : verifierAdapter.buildCommand({ prompt: verifierPrompt(), schema: RESULT_SCHEMA }));
  try {
    return await runSpike({
      contract: runContract, baseRoot: fixture.baseRoot, sourceRoot: fixture.sourceRoot,
      deliveryRoot: fixture.deliveryRoot, now, timeoutMs: 120_000, outputCap: 262144,
      credentialFiles, env: {}, executorSchema: ARTIFACT_SCHEMA, verifierSchema: RESULT_SCHEMA,
      verifierCommand, debugOutput: true,
      ...(variant === 'clean'
        ? { executorCommand: commandFor(executorAdapter, executorFamily === 'openai-codex'
          ? executorAdapter.buildExecutorCommand({ prompt: executorPrompt(), outputSchema: '/scratch/artifact-schema.json', lastMessagePath: '/scratch/artifact.json' })
          : executorAdapter.buildExecutorCommand({ prompt: executorPrompt(), schema: ARTIFACT_SCHEMA })) }
        : { execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'DEFECT\n', { mode: 0o600 }) }),
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

export async function runLiveCase(name, variant) {
  if (!['codex-to-claude', 'claude-to-codex'].includes(name) || !['clean', 'defect'].includes(variant)) {
    throw new Error('live case must name a lane and clean or defect');
  }
  const adapters = {
    'openai-codex': createCodexAdapter({ command: command('codex') }),
    anthropic: createClaudeAdapter({ command: command('claude'), model: 'haiku' }),
  };
  const credentialFiles = {
    'openai-codex': path.join(os.homedir(), '.codex', 'auth.json'),
    anthropic: path.join(os.homedir(), '.claude', '.credentials.json'),
  };
  return lane(name, variant, adapters, credentialFiles);
}

export async function runLiveMatrix() {
  const adapters = {
    'openai-codex': createCodexAdapter({ command: command('codex') }),
    anthropic: createClaudeAdapter({ command: command('claude'), model: 'haiku' }),
  };
  const credentialFiles = {
    'openai-codex': path.join(os.homedir(), '.codex', 'auth.json'),
    anthropic: path.join(os.homedir(), '.claude', '.credentials.json'),
  };
  const report = { schema: 'omp-cross-runtime-spike-report/v1', versions: {
    codex: adapters['openai-codex'].version, claude: adapters.anthropic.version,
  }, lanes: {} };
  for (const name of ['codex-to-claude', 'claude-to-codex']) {
    report.lanes[name] = {};
    for (const variant of ['clean', 'defect']) {
      const result = await lane(name, variant, adapters, credentialFiles);
      report.lanes[name][variant] = {
        verdict: result.verification.verdict,
        findings: result.verification.findings,
        contractDigest: result.envelope.contractDigest,
        artifactDigest: result.envelope.artifactDigest,
        envelopeDigest: result.envelope.envelopeDigest,
        executorFamily: result.envelope.executorFamily,
        verifierFamily: result.envelope.verifierFamily,
        metrics: result.metrics,
      };
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const report = process.argv[2]
    ? await runLiveCase(process.argv[2], process.argv[3])
    : await runLiveMatrix();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
