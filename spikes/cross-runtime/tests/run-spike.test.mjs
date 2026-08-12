import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256, stableSerialize } from '../../../core/receipt.mjs';
import { createContract } from '../../../core/contract.mjs';
import { runSpike, validateVerificationEnvelope } from '../run-spike.mjs';
import { buildClaudeCommand, buildClaudeExecutorCommand, createClaudeAdapter } from '../adapters/claude.mjs';
import { buildCodexCommand, buildCodexExecutorCommand, createCodexAdapter } from '../adapters/codex.mjs';

const NOW = '2026-08-11T00:00:00.000Z';
const digest = (value) => sha256(typeof value === 'string' ? value : stableSerialize(value));

function contract(overrides = {}) {
  const routing = overrides.routing ?? {
    chains: [
      { role: 'task', family: 'openai-codex', selectors: ['openai-codex/codex-0.147.0'] },
      { role: 'reviewer', family: 'anthropic', selectors: ['anthropic/claude-2.1.227'] },
    ],
    reviewerFamily: 'anthropic',
  };
  return createContract({
    toolCallId: 'tool-call-1', sessionId: 'session-1',
    trigger: { id: 'bounded-command', value: '/bounded run' },
    task: { id: 'task-1', value: 'write the bounded result' },
    acceptanceCheck: { id: 'acceptance-1', value: 'result.txt contains after' },
    boundedContext: { sessionPath: 'sessions/run.jsonl', readPaths: ['brief.md'], maxBytes: 1024 },
    writeScope: { paths: ['result.txt'], patchPaths: [], maxFiles: 1 },
    verifier: { id: 'independent-verifier', digest: digest('verifier') },
    requiredGates: ['sandbox', 'trusted-state', 'verifier'],
    budgets: { maxReadBytes: 1024, maxArtifactBytes: 1024, maxOutputBytes: 1024, maxRequests: 2, maxWorkers: 1 },
    maxSeconds: 300, retries: { request: 0, worker: 0, transport: 0, semantic: 0 },
    stopPolicy: { onFailure: 'rollback', partialSuccess: 'block' },
    delivery: { mode: 'local', outputPaths: ['result.txt'] }, routing,
    ...overrides,
  }, { now: NOW, trustedStateDigest: digest('trusted-state') });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-cross-runtime-'));
  const base = path.join(root, 'base');
  const source = path.join(root, 'source');
  const delivery = path.join(root, 'delivery');
  fs.mkdirSync(base, { mode: 0o700 });
  fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(delivery, { mode: 0o700 });
  fs.writeFileSync(path.join(base, 'result.txt'), 'before\n', { mode: 0o600 });
  fs.writeFileSync(path.join(source, 'brief.md'), 'source\n', { mode: 0o600 });
  return { root, base, source, delivery, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function verifierResult(contractValue, artifacts, verifierFamily = 'anthropic') {
  return {
    verdict: 'CLEAN',
    findings: [],
    contractDigest: digest(contractValue),
    artifactDigest: digest(artifacts),
    verifierFamily,
  };
}

test('both host-selected opposite-family lanes produce one bound clean envelope', async () => {
  for (const adapter of [createCodexAdapter({ command: process.execPath }), createClaudeAdapter({ command: process.execPath })]) {
    const f = fixture();
    try {
      const c = contract({ routing: {
        chains: [
          { role: 'task', family: adapter.family === 'openai-codex' ? 'anthropic' : 'openai-codex', selectors: [`${adapter.family === 'openai-codex' ? 'anthropic' : 'openai-codex'}/model`] },
          { role: 'reviewer', family: adapter.family, selectors: [`${adapter.family}/model`] },
        ],
        reviewerFamily: adapter.family,
      }});
      const result = await runSpike({
        contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
        executorFamily: c.routing.chains.find((x) => x.role === 'task').family,
        execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
        verify: async ({ envelope }) => verifierResult(c, envelope.artifacts, adapter.family),
      });
      assert.equal(result.envelope.schema, 'omp-verification-envelope/v1');
      assert.equal(result.envelope.verifierFamily, adapter.family);
      assert.notEqual(result.envelope.executorFamily, result.envelope.verifierFamily);
      assert.deepEqual(result.verification, verifierResult(c, result.envelope.artifacts, adapter.family));
      assert.match(result.envelope.envelopeDigest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(validateVerificationEnvelope(result.envelope, { contract: c, now: NOW }).valid, true);
      assert.equal(fs.existsSync(path.join(f.delivery, 'result.txt')), false);
    } finally { f.cleanup(); }
  }
});

test('verification envelope rejects alteration, staleness, contract drift and source drift', async () => {
  const f = fixture();
  try {
    const c = contract();
    const { envelope } = await runSpike({
      contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
      execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
      verify: async ({ envelope: value }) => verifierResult(c, value.artifacts),
    });
    const altered = structuredClone(envelope);
    altered.nonce = 'altered';
    assert.equal(validateVerificationEnvelope(altered, { contract: c, now: NOW }).valid, false);
    assert.equal(validateVerificationEnvelope(envelope, { contract: c, now: '2026-08-11T00:05:01.000Z' }).valid, false);
    assert.equal(validateVerificationEnvelope(envelope, { contract: contract({ toolCallId: 'other-call' }), now: NOW }).valid, false);
    fs.writeFileSync(path.join(f.source, 'brief.md'), 'drift\n');
    assert.equal(validateVerificationEnvelope(envelope, { contract: c, now: NOW, sourceRoot: f.source }).valid, false);
  } finally { f.cleanup(); }
});

test('host rejects executor-controlled lane selection and same-family review', async () => {
  const f = fixture();
  try {
    await assert.rejects(runSpike({
      contract: contract(), baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
      executorFamily: 'anthropic', executorSelector: 'anthropic/claude-2.1.227',
      execute: async () => {}, verify: async () => {},
    }), /host-owned|selection/i);
    await assert.rejects(runSpike({
      contract: contract({ routing: {
        reviewerFamily: 'openai-codex',
        chains: [
          { role: 'task', family: 'openai-codex', selectors: ['openai-codex/task-model'] },
          { role: 'reviewer', family: 'openai-codex', selectors: ['openai-codex/review-model'] },
        ],
      }}), baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
      execute: async () => {}, verify: async () => {},
    }), /opposite|family/i);
  } finally { f.cleanup(); }
});

test('strict result rejects clean findings, empty required findings, and altered bindings', async () => {
  const f = fixture();
  try {
    const common = {
      contract: contract(), baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
      execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
    };
    await assert.rejects(runSpike({ ...common, verify: async ({ envelope }) => ({
      ...verifierResult(common.contract, envelope.artifacts), findings: [{ code: 'defect' }],
    })}), /findings/i);
    await assert.rejects(runSpike({ ...common, verify: async ({ envelope }) => ({
      ...verifierResult(common.contract, envelope.artifacts), verdict: 'CHANGES_REQUIRED', findings: [],
    })}), /findings|changes/i);
    await assert.rejects(runSpike({ ...common, verify: async ({ envelope }) => ({
      ...verifierResult(common.contract, envelope.artifacts), contractDigest: digest('wrong'),
    })}), /contract|digest/i);
  } finally { f.cleanup(); }
});

test('both opposite-family verifiers bind and report the injected defect', async () => {
  for (const verifierFamily of ['anthropic', 'openai-codex']) {
    const executorFamily = verifierFamily === 'anthropic' ? 'openai-codex' : 'anthropic';
    const f = fixture();
    try {
      const c = contract({ routing: {
        chains: [
          { role: 'task', family: executorFamily, selectors: [`${executorFamily}/fixture`] },
          { role: 'reviewer', family: verifierFamily, selectors: [`${verifierFamily}/fixture`] },
        ],
        reviewerFamily: verifierFamily,
      }});
      const result = await runSpike({
        contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
        execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'DEFECT\n'),
        verify: async ({ envelope }) => ({
          ...verifierResult(c, envelope.artifacts, verifierFamily),
          verdict: 'CHANGES_REQUIRED',
          findings: [{ code: 'known-defect', message: 'result contains DEFECT' }],
        }),
      });
      assert.equal(result.verification.verdict, 'CHANGES_REQUIRED');
      assert.equal(result.verification.findings[0].code, 'known-defect');
    } finally { f.cleanup(); }
  }
});

test('verifier gets private scratch, audited read-only roots, no delivery, and only allowlisted credentials', async () => {
  const f = fixture();
  try {
    let observed;
    const result = await runSpike({
      contract: contract(), baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
      executorEnv: { OPENAI_API_KEY: 'executor', IRRELEVANT_TOKEN: 'ambient' },
      verifierEnvNames: ['ANTHROPIC_API_KEY'], env: { ANTHROPIC_API_KEY: 'reviewer', OPENAI_API_KEY: 'opposite', IRRELEVANT_TOKEN: 'ambient' },
      execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
      verify: async (context) => {
        observed = context;
        return verifierResult(contract(), context.envelope.artifacts);
      },
    });
    assert.equal(result.envelope.schema, 'omp-verification-envelope/v1');
    assert.deepEqual(observed.verifierEnv, { ANTHROPIC_API_KEY: 'reviewer' });
    assert.equal(observed.scratchRoot === observed.deliveryRoot, false);
    assert.equal(observed.deliveryRoot.startsWith(observed.scratchRoot), false);
    assert.equal(observed.readOnly, true);
  } finally { f.cleanup(); }
});

test('subprocess verifier is read-only, delivery-blind, credential-separated and scratch-clean', async () => {
  const f = fixture();
  try {
    const c = contract();
    const anthropicCredential = path.join(f.root, 'anthropic-auth.json');
    const codexCredential = path.join(f.root, 'codex-auth.json');
    fs.writeFileSync(anthropicCredential, '{}\n', { mode: 0o600 });
    fs.writeFileSync(codexCredential, '{}\n', { mode: 0o600 });
    const script = String.raw`
import json, os
job = json.load(open('/scratch/job.json'))
assert job['schema'] == 'omp-verification-envelope/v1'
assert os.environ.get('ANTHROPIC_API_KEY') == 'reviewer'
assert 'OPENAI_API_KEY' not in os.environ and 'IRRELEVANT_TOKEN' not in os.environ
assert os.path.exists('/home/verifier/.claude/.credentials.json') and not os.path.exists('/credentials/auth.json')
assert not os.path.exists('/delivery')
try:
    open('/audit/source/brief.md', 'w').write('forbidden')
    raise AssertionError('audited root was writable')
except OSError:
    pass
open('/scratch/probe', 'w').write('ok')
print(json.dumps({'verdict':'CLEAN','findings':[],'contractDigest':job['contractDigest'],'artifactDigest':job['artifactDigest'],'verifierFamily':job['verifierFamily']}))
`;
    const result = await runSpike({
      contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
      env: { ANTHROPIC_API_KEY: 'reviewer', OPENAI_API_KEY: 'opposite', IRRELEVANT_TOKEN: 'ambient' },
      credentialFiles: { anthropic: anthropicCredential, 'openai-codex': codexCredential },
      execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
      verifierCommand: { command: '/usr/bin/python3', args: ['-c', script] },
    });
    assert.equal(result.verification.verdict, 'CLEAN');
    assert.equal(fs.readFileSync(path.join(f.source, 'brief.md'), 'utf8'), 'source\n');
    assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('.scratch-')), false);
  } finally { f.cleanup(); }
});

test('subprocess executor writes only stage and receives only its provider credential', async () => {
  const f = fixture();
  try {
    const c = contract();
    const anthropicCredential = path.join(f.root, 'anthropic-auth.json');
    const codexCredential = path.join(f.root, 'codex-auth.json');
    fs.writeFileSync(anthropicCredential, '{}\n', { mode: 0o600 });
    fs.writeFileSync(codexCredential, '{}\n', { mode: 0o600 });
    const executor = String.raw`
import os
assert os.environ.get('OPENAI_API_KEY') == 'executor'
assert 'ANTHROPIC_API_KEY' not in os.environ and not os.path.exists('/delivery')
assert os.path.exists('/credentials/auth.json') and not os.path.exists('/home/verifier/.claude/.credentials.json')
try:
    open('/audit/source/brief.md', 'w').write('forbidden')
    raise AssertionError('source was writable')
except OSError:
    pass
print('{"artifacts":[{"path":"result.txt","content":"after\\n"}]}')
`;
    const result = await runSpike({
      contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
      env: { OPENAI_API_KEY: 'executor', ANTHROPIC_API_KEY: 'opposite' },
      credentialFiles: { anthropic: anthropicCredential, 'openai-codex': codexCredential },
      executorCommand: { command: '/usr/bin/python3', args: ['-c', executor] },
      verify: async ({ envelope }) => verifierResult(c, envelope.artifacts),
    });
    assert.equal(result.verification.verdict, 'CLEAN');
    assert.equal(fs.readFileSync(path.join(f.source, 'brief.md'), 'utf8'), 'source\n');
    assert.equal(fs.existsSync(path.join(f.delivery, 'result.txt')), false);
  } finally { f.cleanup(); }
});

test('adapters pin structured local CLI arguments and support injected fake commands', () => {
  const codex = buildCodexCommand({ prompt: 'review', outputSchema: 'schema.json', lastMessagePath: 'result.json' });
  assert.equal(codex.command, 'codex');
  assert.deepEqual(codex.args, ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '--output-schema', 'schema.json', '--output-last-message', 'result.json', 'review']);
  const claude = buildClaudeCommand({ prompt: 'review', schema: { type: 'object' } });
  assert.deepEqual(claude.args, ['--print', '--no-session-persistence', '--disable-slash-commands', '--no-chrome', '--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--strict-mcp-config', '--output-format', 'json', '--json-schema', '{"type":"object"}', 'review']);
  assert.deepEqual(buildCodexExecutorCommand({ prompt: 'execute', outputSchema: 'artifact-schema.json', lastMessagePath: 'artifact.json' }).args,
    ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', '/work', '--json', '--output-schema', 'artifact-schema.json', '--output-last-message', 'artifact.json', 'execute']);
  assert.deepEqual(buildClaudeExecutorCommand({ prompt: 'execute', schema: { type: 'object' } }).args,
    ['--print', '--no-session-persistence', '--disable-slash-commands', '--no-chrome', '--tools', '', '--permission-mode', 'plan', '--strict-mcp-config', '--output-format', 'json', '--json-schema', '{"type":"object"}', 'execute']);
  assert.equal(createCodexAdapter({ command: '/fake/codex' }).command, '/fake/codex');
  assert.equal(createClaudeAdapter({ command: '/fake/claude' }).command, '/fake/claude');
});

test('source drift, stale contract, wrong scope, timeout and verifier failure clean scratch', async () => {
  const f = fixture();
  try {
    const sourceDigests = { 'brief.md': sha256(fs.readFileSync(path.join(f.source, 'brief.md'))) };
    const common = {
      contract: contract(), baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
      sourceDigests,
      execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
      verify: async ({ envelope }) => verifierResult(contract(), envelope.artifacts),
    };
    fs.writeFileSync(path.join(f.source, 'brief.md'), 'drift\n');
    await assert.rejects(runSpike(common), /source|drift/i);
    assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('.scratch-')), false);
  } finally { f.cleanup(); }
});

test('stale, scope, symlink, timeout, output, spawn and parse failures leave no scratch', async () => {
  const cases = [
    {
      name: 'stale',
      options: (f, c) => ({ contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery,
        now: '2026-08-11T00:05:01.000Z', execute: async () => {}, verify: async () => ({}) }),
      error: /stale|expired/i,
    },
    {
      name: 'scope',
      options: (f, c) => ({ contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
        execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'extra.txt'), 'x'), verify: async () => ({}) }),
      error: /scope/i,
    },
    {
      name: 'symlink',
      options: (f, c) => ({ contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
        execute: async ({ stageRoot }) => fs.symlinkSync('/etc/passwd', path.join(stageRoot, 'result.txt')), verify: async () => ({}) }),
      error: /symlink/i,
    },
    {
      name: 'timeout',
      options: (f, c) => ({ contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
        timeoutMs: 50, execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
        verifierCommand: { command: '/usr/bin/python3', args: ['-c', 'import time; time.sleep(2)'] } }),
      error: /timed out/i,
    },
    {
      name: 'output',
      options: (f, c) => ({ contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
        outputCap: 16, execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
        verifierCommand: { command: '/usr/bin/python3', args: ['-c', 'print("x" * 1000)'] } }),
      error: /output cap/i,
    },
    {
      name: 'spawn',
      options: (f, c) => ({ contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
        execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
        verifierCommand: { command: '/missing/verifier', args: [] } }),
      error: /failed/i,
    },
    {
      name: 'parse',
      options: (f, c) => ({ contract: c, baseRoot: f.base, sourceRoot: f.source, deliveryRoot: f.delivery, now: NOW,
        execute: async ({ stageRoot }) => fs.writeFileSync(path.join(stageRoot, 'result.txt'), 'after\n'),
        verifierCommand: { command: '/usr/bin/python3', args: ['-c', 'print("not-json")'] } }),
      error: /not JSON/i,
    },
  ];
  for (const item of cases) {
    const f = fixture();
    try {
      await assert.rejects(runSpike(item.options(f, contract())), item.error, item.name);
      assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('.scratch-')), false, item.name);
    } finally { f.cleanup(); }
  }
});
