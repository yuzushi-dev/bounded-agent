import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createContract } from '../../plugins/bounded/src/contract.mjs';
import { decidePreToolUse } from '../../plugins/bounded/src/policy.mjs';

const NOW = '2026-08-11T12:00:00.000Z';

function fixture() {
  const contract = createContract({
    cwd: '/tmp/bounded-project',
    task: 'update one local file',
    acceptanceCheck: 'node --test test/local.test.mjs',
    scope: ['src/index.mjs'],
    maxSeconds: 30,
    maxReadBytes: 4096,
    maxArtifactBytes: 4096,
    maxOutputBytes: 4096,
    maxRequests: 4,
    prohibitedEffects: 'all external effects',
    finalGate: 'human-approval',
  }, { now: NOW });
  const state = {
    status: 'active',
    cwd: contract.cwd,
    contractDigest: contract.digest,
    requestCount: 0,
    readBytes: 0,
    artifactBytes: 0,
    outputBytes: 0,
  };
  return { contract, state };
}

test('allows an in-scope patch and denies shell execution during a bounded run', () => {
  const { contract, state } = fixture();
  assert.deepEqual(decidePreToolUse({
    event: {
      cwd: contract.cwd,
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Update File: src/index.mjs\n@@\n-old\n+new\n*** End Patch' },
    },
    contract,
    state,
    now: NOW,
  }), { allow: true });

  assert.equal(decidePreToolUse({
    event: { cwd: contract.cwd, tool_name: 'Bash', tool_input: { command: 'node --test test/local.test.mjs' } },
    contract,
    state,
    now: NOW,
  }).allow, false);
});

test('denies scope widening, dispatch, credentials, and external effects', () => {
  const { contract, state } = fixture();
  const denied = (tool_name, tool_input) => decidePreToolUse({
    event: { cwd: contract.cwd, tool_name, tool_input }, contract, state, now: NOW,
  }).allow;

  assert.equal(denied('apply_patch', { command: '*** Begin Patch\n*** Update File: outside.mjs\n@@\n-old\n+new\n*** End Patch' }), false);
  assert.equal(denied('Agent', { prompt: 'do more work' }), false);
  assert.equal(denied('Bash', { command: 'git push origin main' }), false);
  assert.equal(denied('Bash', { command: 'curl https://example.test' }), false);
  assert.equal(denied('Bash', { command: 'printf "api_key=secret"' }), false);
  assert.equal(denied('Bash', {
    command: "node -e \"import('./plugins/bounded/src/state.mjs').then(({createStateStore}) => createStateStore())\"",
  }), false);
});

test('fails closed on drift, expiry, and request exhaustion', () => {
  const { contract, state } = fixture();
  assert.equal(decidePreToolUse({
    event: { cwd: contract.cwd, tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\n*** Update File: src/index.mjs\n*** End Patch' } },
    contract: { ...contract, task: 'drifted' }, state, now: NOW,
  }).allow, false);
  assert.equal(decidePreToolUse({
    event: { cwd: contract.cwd, tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\n*** Update File: src/index.mjs\n*** End Patch' } },
    contract, state, now: '2026-08-11T12:00:30.000Z',
  }).allow, false);
  assert.equal(decidePreToolUse({
    event: { cwd: contract.cwd, tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\n*** Update File: src/index.mjs\n*** End Patch' } },
    contract, state: { ...state, requestCount: contract.budgets.maxRequests }, now: NOW,
  }).allow, false);
});

test('denies sensitive reads, symlink targets, and patch moves outside scope', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-policy-project-'));
  const source = path.join(cwd, 'src');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-policy-outside-'));
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(cwd, '.ssh'));
  fs.writeFileSync(path.join(cwd, '.ssh', 'config'), 'secret');
  fs.writeFileSync(path.join(source, '.env'), 'secret');
  fs.writeFileSync(path.join(source, 'index.mjs'), 'export const value = 1;');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(source, 'link.txt'));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const contract = createContract({
    cwd,
    task: 'edit source',
    acceptanceCheck: 'external check',
    scope: ['src'],
    maxSeconds: 30,
    maxReadBytes: 4096,
    maxArtifactBytes: 4096,
    maxOutputBytes: 4096,
    maxRequests: 4,
    prohibitedEffects: 'all external effects',
    finalGate: 'human-approval',
  }, { now: NOW });
  const state = { status: 'active', cwd, contractDigest: contract.digest, requestCount: 0, readBytes: 0, artifactBytes: 0, outputBytes: 0 };
  const denied = (tool_name, tool_input) => decidePreToolUse({
    event: { cwd, tool_name, tool_input }, contract, state, now: NOW,
  }).allow;

  assert.equal(denied('Read', { path: '/home/example-user/.ssh/id_rsa' }), false);
  assert.equal(denied('Read', { path: '.ssh/config' }), false);
  assert.equal(denied('Read', { path: 'src/.env' }), false);
  assert.equal(denied('Grep', { path: 'src', pattern: 'secret' }), false);
  assert.equal(denied('Grep', { pattern: 'secret' }), false);
  assert.equal(denied('Grep', { path: 'src/index.mjs', pattern: 'value' }), true);
  assert.equal(denied('LS', {}), false);
  assert.equal(denied('Glob', { pattern: '/home/example-user/.ssh/**' }), false);
  assert.equal(denied('Glob', { pattern: '../outside/**' }), false);
  assert.equal(denied('Read', { path: 'src/link.txt' }), false);
  assert.equal(denied('Read', { path: '../outside/secret.txt' }), false);
  assert.equal(denied('apply_patch', {
    command: '*** Begin Patch\n*** Update File: src/main.mjs\n*** Move to: ../outside.mjs\n@@\n-old\n+new\n*** End Patch',
  }), false);
});
