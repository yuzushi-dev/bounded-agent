import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claudeModelTiers,
  codexModelTiers,
  resolveModelTier,
  routingForAssurance,
} from '../../plugins/bounded/src/model-routing.mjs';

test('Codex defaults preserve user main and use xhigh verifier tiers', () => {
  const tiers = codexModelTiers();
  assert.deepEqual(tiers.fast, { model: 'gpt-5.6-luna', modelReasoningEffort: 'xhigh' });
  assert.deepEqual(tiers.standard, { model: 'gpt-5.6-luna', modelReasoningEffort: 'xhigh' });
  assert.deepEqual(tiers.strong, { model: 'gpt-5.6-sol', modelReasoningEffort: 'medium' });
  const l1 = routingForAssurance('L1', { host: 'codex' });
  assert.equal(l1.verifier.model, 'gpt-5.6-luna');
  assert.equal(l1.verifier.modelReasoningEffort, 'xhigh');
  assert.equal(routingForAssurance('L3', { host: 'codex' }).main.inherited, true);
});

test('Codex L3 uses Luna medium workers and Sol medium final verifier', () => {
  const l3 = routingForAssurance('L3', { host: 'codex' });
  assert.equal(l3.worker.tier, 'standard');
  assert.equal(l3.worker.model, 'gpt-5.6-luna');
  assert.equal(l3.worker.modelReasoningEffort, 'medium');
  assert.equal(l3.worker.profile, 'bounded-standard-worker');
  assert.equal(l3.verifier.model, 'gpt-5.6-sol');
  assert.equal(l3.verifier.modelReasoningEffort, 'medium');
});

test('Claude keeps Haiku available only as the fast mechanical tier', () => {
  const tiers = claudeModelTiers();
  assert.deepEqual(tiers.fast, { model: 'haiku', modelReasoningEffort: null });
  assert.deepEqual(tiers.standard, { model: 'sonnet', modelReasoningEffort: null });
  assert.deepEqual(tiers.strong, { model: 'opus', modelReasoningEffort: null });
});

test('Claude L1 and L2 use Sonnet verifier; L3 uses Sonnet workers and Opus verifier', () => {
  const l1 = routingForAssurance('L1', { host: 'claude' });
  assert.equal(l1.main.inherited, true);
  assert.equal(l1.verifier.tier, 'standard');
  assert.equal(l1.verifier.model, 'sonnet');
  assert.equal(l1.worker, null);

  const l2 = routingForAssurance('L2', { host: 'claude' });
  assert.equal(l2.verifier.model, 'sonnet');

  const l3 = routingForAssurance('L3', { host: 'claude' });
  assert.equal(l3.worker.model, 'sonnet');
  assert.equal(l3.verifier.model, 'opus');
});

test('host-specific tier overrides stay configurable', () => {
  const routed = resolveModelTier('fast', {
    host: 'claude',
    overrides: { fast: { model: 'company-fast-claude' } },
  });
  assert.equal(routed.model, 'company-fast-claude');
  assert.equal(routed.host, 'claude');
});

test('Claude tiers reject Codex reasoning effort configuration', () => {
  assert.throws(() => resolveModelTier('standard', {
    host: 'claude',
    overrides: { standard: { modelReasoningEffort: 'high' } },
  }), /do not use Codex reasoning effort/);
});
