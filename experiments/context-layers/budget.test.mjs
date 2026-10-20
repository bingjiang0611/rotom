import assert from "node:assert/strict";
import test from "node:test";
import { enforceBudget } from "./budget.mjs";

const report = (credits, unknown = 0) => ({
  limits: { suiteTimeoutMs: 100, reportedCredits: 2 },
  runs: [{ credits: { credits: 1, unknown: 0 } }, { credits: { credits, unknown } }],
});
test("allows work below measured suite limits", () => {
  enforceBudget(report(0.5), 99, () => assert.fail("unexpected abort"));
  enforceBudget({ ...report(0), runs: [] }, 0, () => assert.fail("unexpected abort"));
});
test("aborts before throwing at credit/time limits or unknown metering", () => {
  for (const [value, elapsed] of [[report(1), 99], [report(0), 100], [report(0, 1), 0]]) {
    let aborted = false;
    assert.throws(() => enforceBudget(value, elapsed, () => { aborted = true; }), error => {
      assert.equal(aborted, true, "a swallowed observer exception must not permit continuation");
      return error instanceof assert.AssertionError;
    });
  }
});
