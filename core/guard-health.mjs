const MAX_RECONCILIATION_AGE_USEC = 120_000_000;

export function guardHealthDiagnostics(report) {
  const lastReconciledUs = Number.isSafeInteger(report?.lastReconciled) && report.lastReconciled > 0
    ? report.lastReconciled : null;
  const monotonicNowUs = Number.isSafeInteger(report?.monotonicNow) && report.monotonicNow >= 0
    ? report.monotonicNow : null;
  return {
    lastReconciledUs,
    monotonicNowUs,
    reconciliationAgeUs: lastReconciledUs !== null && monotonicNowUs !== null && monotonicNowUs >= lastReconciledUs
      ? monotonicNowUs - lastReconciledUs : null,
    maxAgeUs: MAX_RECONCILIATION_AGE_USEC,
  };
}

export function guardHealthFailures(report) {
  const failures = [];
  if (report?.timerActive !== true) failures.push('guard timer is inactive');
  if (report?.timerEnabled !== 'enabled') failures.push('guard timer is disabled');
  if (report?.serviceResult !== 'success') failures.push('guard reconciliation has not succeeded');
  if (report?.execMainStatus !== 0) failures.push('guard reconciliation exited unsuccessfully');
  if (!Number.isSafeInteger(report?.lastReconciled) || report.lastReconciled <= 0
    || !Number.isSafeInteger(report?.monotonicNow) || report.monotonicNow < report.lastReconciled
    || report.monotonicNow - report.lastReconciled > MAX_RECONCILIATION_AGE_USEC) {
    failures.push('guard reconciliation is stale');
  }
  return failures;
}
