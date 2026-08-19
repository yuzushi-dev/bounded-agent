import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../skills/bounded-autonomy/SKILL.md', import.meta.url), 'utf8');
const document = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

test('frontmatter declares bounded execution intent', () => {
  assert.ok(document, 'skill must have YAML frontmatter');
  assert.equal(document[1].split('\n')[0], 'name: bounded-autonomy');
  assert.match(document[1], /execution contract/);
  assert.ok(source.trim().split(/\s+/).length < 500, 'skill must stay under 500 words');
});

test('skill defines progressive assurance without mandatory agent fanout', () => {
  assert.match(source, /L0 direct/);
  assert.match(source, /L1 verified/);
  assert.match(source, /L2 planned/);
  assert.match(source, /L3 orchestrated/);
  assert.match(source, /Never spawn an agent for bookkeeping/);
  assert.match(source, /disjoint implementation work or produce independent evidence/);
});

test('skill uses the executable protocol cli', () => {
  assert.match(source, /bounded prepare/);
  assert.match(source, /bounded plan-protocol/);
  assert.match(source, /bounded verifier-brief/);
  assert.match(source, /bounded verify-result/);
  assert.match(source, /A protocol containing unresolved decisions cannot execute/);
});

test('skill uses task-specific evidence instead of universal tdd or coverage', () => {
  assert.match(source, /Bugfixes need reproduction when feasible/);
  assert.match(source, /Migrations need before\/after invariants/);
  assert.match(source, /Dependency updates need build\/type checks/);
  assert.match(source, /Do not impose a fixed coverage percentage/);
});

test('skill keeps external effects behind a separate human decision', () => {
  assert.match(source, /No bounded run authorizes remote Git operations/);
  assert.match(source, /require a separate human decision after local verification/);
});
