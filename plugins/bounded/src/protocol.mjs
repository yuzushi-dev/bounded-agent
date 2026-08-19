import { routingForAssurance } from './model-routing.mjs';

const STRATEGIES = Object.freeze({
  bugfix: {
    evidence: ['reproduce-before-when-feasible', 'regression-test', 'affected-tests', 'diff-scope-check'],
  },
  migration: {
    evidence: ['before-after-invariants', 'migration-test', 'affected-tests', 'diff-scope-check'],
  },
  dependency: {
    evidence: ['build-or-typecheck', 'affected-tests', 'compatibility-check', 'diff-scope-check'],
  },
  refactor: {
    evidence: ['behavior-preservation-tests', 'affected-tests', 'diff-scope-check'],
  },
  config: {
    evidence: ['config-validation', 'smoke-test', 'diff-scope-check'],
  },
  feature: {
    evidence: ['behavior-test', 'affected-tests', 'unhappy-path-check', 'diff-scope-check'],
  },
  generic: {
    evidence: ['relevant-check', 'diff-scope-check'],
  },
});

const ASSURANCE = Object.freeze({
  L0: { name: 'direct', maxSubagents: 0, independentVerifier: false, planning: false, parallel: false },
  L1: { name: 'verified', maxSubagents: 1, independentVerifier: true, planning: false, parallel: false },
  L2: { name: 'planned', maxSubagents: 1, independentVerifier: true, planning: true, parallel: false },
  L3: { name: 'orchestrated', maxSubagents: 8, independentVerifier: true, planning: true, parallel: true },
});

function cleanList(values = []) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

export function inferStrategy(task = '') {
  const text = String(task).toLowerCase();
  if (/\b(bug|fix|regression|crash|race|deadlock|incorrect|broken|failure|error)\b/.test(text)) return 'bugfix';
  if (/\b(migrat(?:e|ion|ing)|schema|backfill|data move|upgrade path)\b/.test(text)) return 'migration';
  if (/\b(dependenc(?:y|ies)|library|package|sdk|version bump|upgrade .*\b(v?\d+))\b/.test(text)) return 'dependency';
  if (/\b(refactor|cleanup|restructure|extract|rename across|move module)\b/.test(text)) return 'refactor';
  if (/\b(config|configuration|yaml|toml|env var|feature flag)\b/.test(text)) return 'config';
  if (/\b(add|implement|introduce|feature|support)\b/.test(text)) return 'feature';
  return 'generic';
}

export function classifyAssurance({ task = '', writePaths = [], unresolvedDecisions = [], riskFlags = [], laneCount = 1 } = {}) {
  const text = String(task).toLowerCase();
  const paths = cleanList(writePaths);
  const risks = cleanList(riskFlags).map((value) => value.toLowerCase());
  const unresolved = cleanList(unresolvedDecisions);
  const highRisk = risks.some((risk) => /security|auth|credential|permission|destructive|data-loss|production|billing|payment|concurrency|irreversible/.test(risk))
    || /\b(auth(?:entication|orization)?|security|permission|credential|payment|billing|delete data|production|concurrency|race condition)\b/.test(text);
  const broad = laneCount > 1 || paths.length > 8 || /\b(cross[- ]module|cross[- ]package|monorepo|system[- ]wide|large migration)\b/.test(text);
  const planningNeeded = unresolved.length > 0 || paths.length > 3 || /\b(migrat(?:e|ion|ing)|refactor|architecture|breaking|redesign)\b/.test(text);
  const trivial = paths.length <= 1 && !highRisk && !planningNeeded && /\b(typo|comment|rename local|format|small config|documentation)\b/.test(text);

  if (highRisk || broad) return 'L3';
  if (planningNeeded) return 'L2';
  if (trivial) return 'L0';
  return 'L1';
}

export function buildExecutionProtocol(input = {}) {
  const task = String(input.task || '').trim();
  if (!task) throw new Error('task is required');
  const writePaths = cleanList(input.writePaths);
  if (!writePaths.length) throw new Error('at least one write path is required');
  const readPaths = cleanList(input.readPaths);
  const acceptance = cleanList(input.acceptance);
  if (!acceptance.length) throw new Error('at least one acceptance criterion is required');
  const unresolvedDecisions = cleanList(input.unresolvedDecisions);
  const strategy = input.strategy || inferStrategy(task);
  if (!STRATEGIES[strategy]) throw new Error(`unsupported strategy: ${strategy}`);
  const level = input.assurance || classifyAssurance({
    task,
    writePaths,
    unresolvedDecisions,
    riskFlags: input.riskFlags,
    laneCount: Number(input.laneCount || 1),
  });
  if (!ASSURANCE[level]) throw new Error(`unsupported assurance level: ${level}`);
  const lanes = Array.isArray(input.lanes) ? input.lanes.map((lane) => ({
    id: String(lane.id || '').trim(),
    owns: cleanList(lane.owns),
    dependsOn: cleanList(lane.dependsOn),
  })) : [];
  if (level !== 'L3' && lanes.length > 1) throw new Error('parallel lanes require L3 assurance');
  for (const lane of lanes) {
    if (!lane.id || !lane.owns.length) throw new Error('each lane requires id and owned paths');
  }

  return {
    version: 1,
    task,
    strategy,
    assurance: { level, ...ASSURANCE[level] },
    routing: routingForAssurance(level, { host: input.host || 'codex', overrides: input.modelTiers || {} }),
    scope: { readPaths, writePaths },
    acceptance: acceptance.map((value, index) => ({ id: `A${index + 1}`, value })),
    evidence: cleanList(input.evidence?.length ? input.evidence : STRATEGIES[strategy].evidence),
    unresolvedDecisions,
    mustAskUser: unresolvedDecisions.length > 0,
    effects: {
      network: input.effects?.network || 'deny',
      remoteGit: input.effects?.remoteGit || 'deny',
      deploy: input.effects?.deploy || 'deny',
      destructive: input.effects?.destructive || 'deny',
      thirdParty: input.effects?.thirdParty || 'deny',
    },
    limits: {
      maxSeconds: Number(input.limits?.maxSeconds || (level === 'L3' ? 1800 : level === 'L2' ? 900 : 300)),
      maxRequests: Number(input.limits?.maxRequests || (level === 'L3' ? 16 : level === 'L2' ? 8 : 4)),
      maxReadBytes: Number(input.limits?.maxReadBytes || 262144),
      maxArtifactBytes: Number(input.limits?.maxArtifactBytes || 1048576),
      maxOutputBytes: Number(input.limits?.maxOutputBytes || 262144),
    },
    lanes,
    publicationGate: 'human-approval',
  };
}

export function buildVerifierBrief(protocol, { diffSummary = '', testEvidence = '', runtimeEvidence = '' } = {}) {
  if (!protocol?.task || !protocol?.acceptance) throw new Error('valid protocol is required');
  return {
    role: 'fresh-verifier',
    routing: protocol.routing?.verifier || null,
    instruction: 'Judge the delivered change from repository evidence. Do not trust implementation claims. Return PASS only when every acceptance criterion is demonstrated and no unrelated changes or regressions are found.',
    task: protocol.task,
    strategy: protocol.strategy,
    acceptance: protocol.acceptance,
    requiredEvidence: protocol.evidence,
    allowedWriteScope: protocol.scope.writePaths,
    diffSummary: String(diffSummary),
    testEvidence: String(testEvidence),
    runtimeEvidence: String(runtimeEvidence),
    outputSchema: {
      verdict: 'PASS|FAIL',
      criteria: [{ id: 'A1', status: 'PASS|FAIL|UNPROVEN', evidence: 'string' }],
      findings: ['string'],
    },
  };
}

export function validateVerifierResult(protocol, result) {
  if (!result || !['PASS', 'FAIL'].includes(result.verdict)) throw new Error('verifier verdict must be PASS or FAIL');
  const expected = new Set(protocol.acceptance.map(({ id }) => id));
  const seen = new Map((result.criteria || []).map((item) => [item.id, item]));
  const missing = [...expected].filter((id) => !seen.has(id));
  const failed = [...expected].filter((id) => seen.has(id) && seen.get(id).status !== 'PASS');
  const findings = cleanList(result.findings);
  const pass = result.verdict === 'PASS' && missing.length === 0 && failed.length === 0 && findings.length === 0;
  return { pass, missing, failed, findings };
}

export { ASSURANCE, STRATEGIES };
