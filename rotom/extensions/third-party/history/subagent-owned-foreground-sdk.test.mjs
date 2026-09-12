import { test } from "node:test";
import { prepareOwnedForegroundCandidate } from "./fixtures/prepare-owned-foreground.mjs";
import { runOwnedExecutionSdk } from "./fixtures/run-owned-execution-sdk.mjs";
test("real scoped default foreground workflow closes writers and leases without async conversion or alias replay", { timeout: 125000 }, async t => {
	await runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedForegroundCandidate, expectWorkflowClosure: true, expectForegroundClosure: true });
});
