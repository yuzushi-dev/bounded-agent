import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'plugins', 'bounded', 'bin', 'bounded.mjs');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('prepare emits a usable proportional protocol', () => {
  const result = run([
    'prepare',
    '--task', 'Fix parser regression',
    '--scope', 'src/parser.mjs,tests/parser.test.mjs',
    '--acceptance', 'malformed input returns E_PARSE,parser tests stay green',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const protocol = JSON.parse(result.stdout);
  assert.equal(protocol.strategy, 'bugfix');
  assert.equal(protocol.assurance.level, 'L1');
  assert.equal(protocol.assurance.maxSubagents, 1);
  assert.equal(protocol.effects.remoteGit, 'deny');
  assert.equal(protocol.mustAskUser, false);
});

test('prepare blocks semantic forks in the protocol', () => {
  const result = run([
    'prepare',
    '--task', 'Change API response behavior',
    '--scope', 'src/api.mjs',
    '--acceptance', 'response contract is tested',
    '--unresolved', 'preserve the legacy response shape?',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const protocol = JSON.parse(result.stdout);
  assert.equal(protocol.mustAskUser, true);
  assert.equal(protocol.assurance.level, 'L2');
});

test('verifier brief and result validation form a closed loop', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-protocol-'));
  fs.chmodSync(temp, 0o700);
  const protocolPath = path.join(temp, 'protocol.json');
  const prepared = run([
    'prepare',
    '--task', 'Fix parser regression',
    '--scope', 'src/parser.mjs',
    '--acceptance', 'malformed input returns E_PARSE,parser tests stay green',
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  fs.writeFileSync(protocolPath, prepared.stdout, { mode: 0o600 });

  const brief = run([
    'verifier-brief', '--protocol', protocolPath,
    '--diff-summary', 'src/parser.mjs changed',
    '--test-evidence', 'node --test tests/parser.test.mjs: pass',
  ]);
  assert.equal(brief.status, 0, brief.stderr);
  const parsedBrief = JSON.parse(brief.stdout);
  assert.equal(parsedBrief.role, 'fresh-verifier');
  assert.equal(parsedBrief.acceptance.length, 2);

  const resultPath = path.join(temp, 'verifier-result.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    verdict: 'PASS',
    criteria: [
      { id: 'A1', status: 'PASS', evidence: 'regression test' },
      { id: 'A2', status: 'PASS', evidence: 'parser suite' },
    ],
    findings: [],
  }), { mode: 0o600 });

  const validated = run(['verify-result', '--protocol', protocolPath, '--result-file', resultPath]);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).pass, true);
});
