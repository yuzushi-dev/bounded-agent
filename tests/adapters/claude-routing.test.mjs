import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENTS = path.join(ROOT, 'adapters', 'claude', 'agents');

function source(name) {
  return fs.readFileSync(path.join(AGENTS, name), 'utf8');
}

function model(name) {
  const match = source(name).match(/^model:\s*(\S+)$/m);
  assert.ok(match, `${name} must declare a model`);
  return match[1];
}

test('Claude semantic verifier tiers use Sonnet and Opus', () => {
  assert.equal(model('bounded-standard-verifier.md'), 'sonnet');
  assert.equal(model('bounded-strong-verifier.md'), 'opus');
});

test('Claude Haiku agent is mechanical-only and cannot replace semantic verification', () => {
  assert.equal(model('bounded-mechanical-checker.md'), 'haiku');
  assert.match(source('bounded-mechanical-checker.md'), /Never serves as the semantic verification gate/i);
  assert.match(source('bounded-mechanical-checker.md'), /UNSUITABLE_FOR_MECHANICAL_CHECK/);
});

test('Claude L3 implementation worker uses Sonnet', () => {
  assert.equal(model('bounded-standard-worker.md'), 'sonnet');
  assert.match(source('bounded-standard-worker.md'), /Do not spawn another agent/);
});

test('Claude bounded skill selects host routing and preserves parent model', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'adapters', 'claude', 'skills', 'bounded-autonomy', 'SKILL.md'), 'utf8');
  assert.match(skill, /--host claude/);
  assert.match(skill, /main Claude model always inherits the user's current model selection/i);
  assert.match(skill, /L1 verified:.*bounded-standard-verifier.*Sonnet/i);
  assert.match(skill, /L2 planned:.*bounded-standard-verifier.*Sonnet/i);
  assert.match(skill, /bounded-strong-verifier.*Opus/);
  assert.match(skill, /bounded-mechanical-checker.*Haiku/);
  assert.match(skill, /must never replace the semantic L1-L3 verifier/i);
});