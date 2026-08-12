import { stateDigest } from './state.mjs';
import { stableSerialize } from './receipt.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function providerGroup(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'openai' || normalized.startsWith('openai-') || normalized.startsWith('openai_')) return 'openai';
  if (normalized === 'anthropic' || normalized.startsWith('anthropic-') || normalized.startsWith('anthropic_')) return 'anthropic';
  if (normalized === 'google' || normalized.startsWith('google-') || normalized.startsWith('google_')) return 'google';
  return normalized;
}

export function validateQualification(state, { now, taskDigest, scopeDigest, evidence } = {}) {
  const qualification = state?.qualification;
  if (qualification?.status !== 'ready'
    || Object.keys(qualification || {}).sort().join(',') !== 'configDigest,expiresAt,nodeDigest,probeDigest,qualifiedAt,reviewDigest,runtimeMountsDigest,scopeDigest,sourceDigests,status,suiteDigest,taskDigest,verifierCapability,workerCapability'
    || !qualification.sourceDigests
    || Object.keys(qualification.sourceDigests).length === 0
    || Object.values(qualification.sourceDigests).some((value) => !DIGEST.test(value))
    || !DIGEST.test(qualification.configDigest || '')
    || !DIGEST.test(qualification.suiteDigest || '')
    || !DIGEST.test(qualification.reviewDigest || '')
    || !DIGEST.test(qualification.runtimeMountsDigest || '')
    || !DIGEST.test(qualification.probeDigest || '')
    || !qualification.workerCapability
    || Object.keys(qualification.workerCapability).sort().join(',') !== 'digest,family'
    || !DIGEST.test(qualification.workerCapability.digest || '')
    || typeof qualification.workerCapability.family !== 'string'
    || !qualification.verifierCapability
    || Object.keys(qualification.verifierCapability).sort().join(',') !== 'digest,family'
    || !DIGEST.test(qualification.verifierCapability.digest || '')
    || typeof qualification.verifierCapability.family !== 'string'
    || !DIGEST.test(qualification.nodeDigest || '')
    || !DIGEST.test(qualification.taskDigest || '')
    || !DIGEST.test(qualification.scopeDigest || '')
    || !Number.isFinite(Date.parse(qualification.qualifiedAt))
    || new Date(qualification.qualifiedAt).toISOString() !== qualification.qualifiedAt
    || !Number.isFinite(Date.parse(qualification.expiresAt))
    || new Date(qualification.expiresAt).toISOString() !== qualification.expiresAt
    || Date.parse(qualification.qualifiedAt) >= Date.parse(qualification.expiresAt)
    || Date.parse(qualification.expiresAt) - Date.parse(qualification.qualifiedAt) > 900_000
    || (now !== undefined && (Date.parse(qualification.qualifiedAt) > Date.parse(now)
      || Date.parse(now) >= Date.parse(qualification.expiresAt)))
    || (taskDigest !== undefined && qualification.taskDigest !== taskDigest)
    || (scopeDigest !== undefined && qualification.scopeDigest !== scopeDigest)
    || (evidence !== undefined && stableSerialize({
      sourceDigests: qualification.sourceDigests,
      configDigest: qualification.configDigest,
      suiteDigest: qualification.suiteDigest,
      reviewDigest: qualification.reviewDigest,
      runtimeMountsDigest: qualification.runtimeMountsDigest,
      probeDigest: qualification.probeDigest,
      workerCapability: qualification.workerCapability,
      verifierCapability: qualification.verifierCapability,
      nodeDigest: qualification.nodeDigest,
    }) !== stableSerialize(evidence))) {
    throw new Error('qualification is missing, stale, or incomplete');
  }
  return stateDigest(state);
}

export function validateExternalEffects(value, prohibitedEffects) {
  if (value?.enabled !== false || value.finalGate !== 'human-approval'
    || prohibitedEffects !== 'all external effects') {
    throw new Error('external effects must remain disabled until human approval');
  }
}

export function validateRouting(request, state) {
  if (stableSerialize(request?.routing) !== stableSerialize(state?.routing)) {
    throw new Error('routing differs from qualified state');
  }
  const task = request.routing?.chains?.find((chain) => chain.role === 'task');
  const reviewer = request.routing?.chains?.find((chain) => chain.role === 'reviewer');
  if (!task || !reviewer || providerGroup(task.family) === providerGroup(reviewer.family)
    || reviewer.family !== request.routing.reviewerFamily
    || !Array.isArray(task.selectors) || task.selectors.length === 0
    || !Array.isArray(reviewer.selectors) || reviewer.selectors.length === 0
    || task.selectors.some((selector) => !selector.startsWith(`${task.family}/`))
    || reviewer.selectors.some((selector) => !selector.startsWith(`${reviewer.family}/`))) {
    throw new Error('routing does not preserve verifier independence');
  }
}
