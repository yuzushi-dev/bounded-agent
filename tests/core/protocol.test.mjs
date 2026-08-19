import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExecutionProtocol,
  buildVerifierBrief,
  classifyAssurance,
  inferStrategy,
  validateVerifierResult,
} from '../../plugins/bounded/src/protocol.mjs';
import { routingForAssurance } from '../../plugins/bounded/src/model-routing.mjs';

test('infers evidence strategy from task language', () => {
  assert.equal(inferStrategy('Fix refresh token regression'), 'bugfix');
  assert.equal(inferStrategy('Migrate account schema to v4'), 'migration');
  assert.equal(inferStrategy('Upgrade react-query dependency to v6'), 'dependency');
  assert.equal(inferStrategy('Refactor the session store'), 'refactor');
});

test('uses L0 only for trivial narrow work', () => {
  assert.equal(classifyAssurance({ task: 'Fix documentation typo', writePaths: ['README.md'] }), 'L0');
  assert.equal(classifyAssurance({ task: 'Fix authentication timeout regression', writePaths: ['src/auth.mjs', 'test/auth.test.mjs'] }), 'L3');
});

test('uses L2 when a task needs planning or has unresolved decisions', () => {
  assert.equal(classifyAssurance({
    task: 'Refactor cache service',
    writePaths: ['src/cache/a.mjs', 'src/cache/b.mjs'],
  }), 'L2');
  assert.equal(classifyAssurance({
    task: 'Change cache behavior',
    writePaths: ['src/cache.mjs'],
    unresolvedDecisions: ['preserve stale-while-revalidate semantics?'],
  }), 'L2');
});

test('routes codex subagents by assurance while preserving the user main model', () => {
  const l0 = routingForAssurance('L0');
  assert.equal(l0.main.tier, 'inherit');
  assert.equal(l0.verifier, null);

  const l1 = routingForAssurance('L1');
  assert.equal(l1.main.inherited, true);
  assert.deepEqual({ model: l1.verifier.model, effort: l1.verifier.modelReasoningEffort }, {
    model: 'gpt-5.6-luna', effort: 'low',
  });

  const l2 = routingForAssurance('L2');
  assert.deepEqual({ model: l2.verifier.model, effort: l2.verifier.modelReasoningEffort }, {
    model: 'gpt-5.6-luna', effort: 'xhigh',
  });

  const l3 = routingForAssurance('L3');
  assert.deepEqual({ model: l3.worker.model, effort: l3.worker.modelReasoningEffort }, {
    model: 'gpt-5.6-luna', effort: 'xhigh',
  });
  assert.deepEqual({ model: l3.verifier.model, effort: l3.verifier.modelReasoningEffort }, {
    model: 'gpt-5.6-sol', effort: 'medium',
  });
});

test('builds an executable protocol with strategy evidence and safe effects', () => {
  const protocol = buildExecutionProtocol({
    task: 'Fix parser regression',
    writePaths: ['src/parser.mjs', 'test/parser.test.mjs'],
    acceptance: ['malformed input returns E_PARSE', 'parser tests stay green'],
  });
  assert.equal(protocol.strategy, 'bugfix');
  assert.equal(protocol.assurance.level, 'L1');
  assert.equal(protocol.assurance.maxSubagents, 1);
  assert.equal(protocol.routing.main.tier, 'inherit');
  assert.equal(protocol.routing.verifier.model, 'gpt-5.6-luna');
  assert.equal(protocol.routing.verifier.modelReasoningEffort, 'low');
  assert.equal(protocol.effects.network, 'deny');
  assert.equal(protocol.publicationGate, 'human-approval');
  assert.deepEqual(protocol.acceptance.map((item) => item.id), ['A1', 'A2']);
  assert.ok(protocol.evidence.includes('regression-test'));
});

test('allows model tier defaults to be overridden without changing assurance policy', () => {
  const protocol = buildExecutionProtocol({
    task: 'Fix parser regression',
    writePaths: ['src/parser.mjs'],
    acceptance: ['parser test passes'],
    modelTiers: { fast: { model: 'gpt-5.6-sol', modelReasoningEffort: 'low' } },
  });
  assert.equal(protocol.assurance.level, 'L1');
  assert.equal(protocol.routing.verifier.tier, 'fast');
  assert.equal(protocol.routing.verifier.model, 'gpt-5.6-sol');
  assert.equal(protocol.routing.verifier.modelReasoningEffort, 'low');
});

test('blocks execution when semantic decisions remain unresolved', () => {
  const protocol = buildExecutionProtocol({
    task: 'Change API response behavior',
    writePaths: ['src/api.mjs'],
    acceptance: ['new response is covered'],
    unresolvedDecisions: ['preserve legacy response shape?'],
  });
  assert.equal(protocol.mustAskUser, true);
  assert.deepEqual(protocol.unresolvedDecisions, ['preserve legacy response shape?']);
});

test('rejects parallel lanes below L3', () => {
  assert.throws(() => buildExecutionProtocol({
    task: 'Update two files',
    assurance: 'L1',
    writePaths: ['a.mjs', 'b.mjs'],
    acceptance: ['tests pass'],
    lanes: [
      { id: 'a', owns: ['a.mjs'] },
      { id: 'b', owns: ['b.mjs'] },
    ],
  }), /parallel lanes require L3/);
});

test('builds a fresh verifier brief without implementation reasoning', () => {
  const protocol = buildExecutionProtocol({
    task: 'Fix parser regression',
    writePaths: ['src/parser.mjs'],
    acceptance: ['malformed input returns E_PARSE'],
  });
  const brief = buildVerifierBrief(protocol, { diffSummary: 'src/parser.mjs changed', testEvidence: 'node --test: pass' });
  assert.equal(brief.role, 'fresh-verifier');
  assert.equal(brief.acceptance[0].id, 'A1');
  assert.equal(brief.routing.tier, 'fast');
  assert.match(brief.instruction, /Do not trust implementation claims/);
});

test('verification passes only when every criterion passes and findings are empty', () => {
  const protocol = buildExecutionProtocol({
    task: 'Fix parser regression',
    writePaths: ['src/parser.mjs'],
    acceptance: ['malformed input returns E_PARSE', 'tests stay green'],
  });
  assert.deepEqual(validateVerifierResult(protocol, {
    verdict: 'PASS',
    criteria: [
      { id: 'A1', status: 'PASS', evidence: 'regression test' },
      { id: 'A2', status: 'PASS', evidence: 'suite pass' },
    ],
    findings: [],
  }), { pass: true, missing: [], failed: [], findings: [] });

  const invalid = validateVerifierResult(protocol, {
    verdict: 'PASS',
    criteria: [{ id: 'A1', status: 'PASS', evidence: 'regression test' }],
    findings: [],
  });
  assert.equal(invalid.pass, false);
  assert.deepEqual(invalid.missing, ['A2']);
});
