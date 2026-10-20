import assert from "node:assert/strict";

// SDK observer errors alone do not stop a provider loop. Abort before throwing.
export function enforceBudget(report, elapsedMs, abort) {
  const exhausted = elapsedMs >= report.limits.suiteTimeoutMs ||
    report.runs.reduce((n, r) => n + (r.credits?.credits ?? 0), 0) >= report.limits.reportedCredits ||
    report.runs.some(r => r.credits?.unknown > 0);
  if (exhausted) {
    abort();
    assert.fail("time/credit limit or unknown metering");
  }
}
