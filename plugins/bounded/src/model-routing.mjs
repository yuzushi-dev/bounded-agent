const CODEX_DEFAULTS = Object.freeze({
  inherit: Object.freeze({ model: null, modelReasoningEffort: null }),
  fast: Object.freeze({ model: 'gpt-5.6-luna', modelReasoningEffort: 'low' }),
  standard: Object.freeze({ model: 'gpt-5.6-luna', modelReasoningEffort: 'xhigh' }),
  strong: Object.freeze({ model: 'gpt-5.6-sol', modelReasoningEffort: 'medium' }),
});

const LEVEL_ROUTING = Object.freeze({
  L0: Object.freeze({ main: 'inherit', verifier: null, worker: null }),
  L1: Object.freeze({ main: 'inherit', verifier: 'fast', worker: null }),
  L2: Object.freeze({ main: 'inherit', verifier: 'standard', worker: null }),
  L3: Object.freeze({ main: 'inherit', verifier: 'strong', worker: 'standard' }),
});

const VALID_TIERS = new Set(Object.keys(CODEX_DEFAULTS));
const VALID_EFFORT = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

function normalizeEntry(name, value) {
  if (!value || typeof value !== 'object') throw new Error(`model tier ${name} must be an object`);
  const model = value.model == null ? null : String(value.model).trim();
  const effort = value.modelReasoningEffort == null ? null : String(value.modelReasoningEffort).trim();
  if (name !== 'inherit' && !model) throw new Error(`model tier ${name} requires model`);
  if (effort != null && !VALID_EFFORT.has(effort)) throw new Error(`unsupported reasoning effort: ${effort}`);
  return Object.freeze({ model, modelReasoningEffort: effort });
}

export function codexModelTiers(overrides = {}) {
  const result = {};
  for (const tier of Object.keys(CODEX_DEFAULTS)) {
    result[tier] = normalizeEntry(tier, { ...CODEX_DEFAULTS[tier], ...(overrides[tier] || {}) });
  }
  return Object.freeze(result);
}

export function resolveModelTier(tier, { host = 'codex', overrides = {} } = {}) {
  if (host !== 'codex') return Object.freeze({ tier, host, model: null, modelReasoningEffort: null, inherited: true });
  if (!VALID_TIERS.has(tier)) throw new Error(`unsupported model tier: ${tier}`);
  const resolved = codexModelTiers(overrides)[tier];
  return Object.freeze({
    tier,
    host,
    model: resolved.model,
    modelReasoningEffort: resolved.modelReasoningEffort,
    inherited: tier === 'inherit',
  });
}

export function routingForAssurance(level, { host = 'codex', overrides = {} } = {}) {
  const policy = LEVEL_ROUTING[level];
  if (!policy) throw new Error(`unsupported assurance level: ${level}`);
  const resolve = (tier) => tier == null ? null : resolveModelTier(tier, { host, overrides });
  return Object.freeze({
    main: resolve(policy.main),
    verifier: resolve(policy.verifier),
    worker: resolve(policy.worker),
  });
}

export { CODEX_DEFAULTS, LEVEL_ROUTING };
