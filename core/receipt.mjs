import { createHash } from 'node:crypto';

export function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function createReceipt({
  contract,
  execution,
  verification,
  completedAt,
  activatedAt = contract.createdAt,
  expiresAt = contract.expiresAt,
}) {
  const receipt = {
    schema: 'omp-run-receipt/v2',
    runId: contract.runId,
    toolCallId: contract.toolCallId,
    status: 'delivered',
    trigger: contract.trigger,
    task: contract.task,
    acceptanceCheck: contract.acceptanceCheck,
    budgetUsage: structuredClone(execution.usage),
    verifier: contract.verifier,
    policy: {
      allowFallback: false,
      externalEffects: { enabled: false, finalGate: 'human-approval' },
    },
    contractDigest: sha256(stableSerialize(contract)),
    trustedStateDigest: contract.trustedStateDigest,
    admittedAt: contract.createdAt,
    activatedAt,
    completedAt,
    expiresAt,
    independentVerifier: structuredClone(verification),
    objectivesComplete: true,
    truncated: false,
    sessionFile: contract.boundedContext.sessionPath,
    outputPaths: [...contract.delivery.outputPaths],
    patchPaths: [...contract.writeScope.patchPaths],
    artifacts: structuredClone(execution.artifacts),
  };
  receipt.receiptDigest = sha256(stableSerialize(receipt));
  return receipt;
}

export function verifyReceipt(receipt, contract) {
  const findings = [];
  const receiptFields = [
    'schema', 'runId', 'toolCallId', 'status', 'trigger', 'task', 'acceptanceCheck', 'budgetUsage', 'verifier', 'policy',
    'contractDigest', 'trustedStateDigest', 'admittedAt', 'activatedAt', 'completedAt', 'expiresAt',
    'independentVerifier', 'objectivesComplete', 'truncated', 'sessionFile', 'outputPaths', 'patchPaths',
    'artifacts', 'receiptDigest',
  ];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join(',') !== receiptFields.sort().join(',')) findings.push({ code: 'fields' });
  if (receipt?.schema !== 'omp-run-receipt/v2') findings.push({ code: 'schema' });
  if (receipt?.status !== 'delivered') findings.push({ code: 'status' });
  if (receipt?.runId !== contract?.runId || receipt?.toolCallId !== contract?.toolCallId) findings.push({ code: 'identity' });
  if (stableSerialize(receipt?.trigger) !== stableSerialize(contract?.trigger)
    || stableSerialize(receipt?.task) !== stableSerialize(contract?.task)
    || stableSerialize(receipt?.acceptanceCheck) !== stableSerialize(contract?.acceptanceCheck)
    || stableSerialize(receipt?.verifier) !== stableSerialize(contract?.verifier)
    || receipt?.sessionFile !== contract?.boundedContext?.sessionPath) findings.push({ code: 'contract-fields' });
  if (!contract || typeof contract !== 'object'
    || receipt?.contractDigest !== sha256(stableSerialize(contract))) findings.push({ code: 'contract-digest' });
  if (receipt?.trustedStateDigest !== contract?.trustedStateDigest) findings.push({ code: 'state-digest' });
  if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
    const unsigned = structuredClone(receipt);
    delete unsigned.receiptDigest;
    if (receipt.receiptDigest !== sha256(stableSerialize(unsigned))) findings.push({ code: 'receipt-digest' });
  } else findings.push({ code: 'receipt-digest' });
  const independent = receipt?.independentVerifier;
  if (!independent || Object.keys(independent).sort().join(',') !== 'artifactDigest,contractDigest,digest,findings,objectives,passed,readOnly,schema,verdict,verifierFamily'
    || independent.schema !== 'omp-independent-verification/v1'
    || independent.passed !== true || independent.readOnly !== true
    || independent.contractDigest !== receipt?.contractDigest
    || independent.artifactDigest !== sha256(stableSerialize(receipt?.artifacts))
    || independent.verifierFamily !== contract?.routing?.reviewerFamily
    || independent.verdict !== 'CLEAN'
    || !Array.isArray(independent.findings) || independent.findings.length !== 0
    || !independent.objectives || typeof independent.objectives !== 'object' || Array.isArray(independent.objectives)
    || Object.keys(independent.objectives).sort().join(',') !== [...(contract?.delivery?.outputPaths || [])].sort().join(',')
    || Object.values(independent.objectives).some((value) => value !== true)
    || !/^sha256:[a-f0-9]{64}$/.test(independent.digest || '')) {
    findings.push({ code: 'verifier' });
  }
  if (receipt?.truncated !== false || receipt?.objectivesComplete !== true
    || receipt?.policy?.allowFallback !== false
    || Object.keys(receipt?.policy || {}).sort().join(',') !== 'allowFallback,externalEffects'
    || Object.keys(receipt?.policy?.externalEffects || {}).sort().join(',') !== 'enabled,finalGate'
    || receipt.policy.externalEffects?.enabled !== false
    || receipt.policy.externalEffects.finalGate !== 'human-approval') findings.push({ code: 'completion' });
  if (stableSerialize(receipt?.outputPaths) !== stableSerialize(contract?.delivery?.outputPaths)
    || stableSerialize(receipt?.patchPaths) !== stableSerialize(contract?.writeScope?.patchPaths)) {
    findings.push({ code: 'scope' });
  }
  if (!Array.isArray(receipt?.artifacts)
    || receipt.artifacts.length !== contract?.delivery?.outputPaths?.length
    || receipt.artifacts.some((artifact) => Object.keys(artifact || {}).sort().join(',') !== 'bytes,digest,path'
      || !contract.delivery.outputPaths.includes(artifact?.path)
      || !Number.isInteger(artifact.bytes) || artifact.bytes < 0
      || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || ''))
    || new Set(receipt.artifacts.map((artifact) => artifact.path)).size !== receipt.artifacts.length) findings.push({ code: 'artifacts' });
  if (!receipt?.budgetUsage
    || Object.keys(receipt?.budgetUsage || {}).sort().join(',') !== 'artifactBytes,outputBytes,readBytes,requests,workers'
    || !['requests', 'workers', 'readBytes', 'artifactBytes', 'outputBytes']
      .every((key) => Number.isInteger(receipt.budgetUsage[key]) && receipt.budgetUsage[key] >= 0)
    || receipt.budgetUsage.requests > contract?.budgets?.maxRequests
    || receipt.budgetUsage.workers > contract?.budgets?.maxWorkers
    || receipt.budgetUsage.readBytes > contract?.budgets?.maxReadBytes
    || receipt.budgetUsage.artifactBytes > contract?.budgets?.maxArtifactBytes
    || receipt.budgetUsage.outputBytes > contract?.budgets?.maxOutputBytes) {
    findings.push({ code: 'budget-usage' });
  }
  if (Array.isArray(receipt?.artifacts)
    && receipt?.budgetUsage?.artifactBytes !== receipt.artifacts.reduce((sum, artifact) => sum + (artifact.bytes || 0), 0)) {
    findings.push({ code: 'artifact-usage' });
  }
  const admitted = Date.parse(receipt?.admittedAt);
  const activated = Date.parse(receipt?.activatedAt);
  const completed = Date.parse(receipt?.completedAt);
  const expires = Date.parse(receipt?.expiresAt);
  const canonical = (value, parsed) => Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  const admittedDuration = Date.parse(contract?.expiresAt) - Date.parse(contract?.createdAt);
  if (receipt?.admittedAt !== contract?.createdAt
    || !canonical(receipt?.activatedAt, activated)
    || !canonical(receipt?.completedAt, completed)
    || !canonical(receipt?.expiresAt, expires)
    || activated < admitted || activated - admitted > 5_000
    || completed < activated || completed >= expires
    || expires <= activated || expires - activated !== admittedDuration) {
    findings.push({ code: 'timing' });
  }
  return { valid: findings.length === 0, findings };
}
