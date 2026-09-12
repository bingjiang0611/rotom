import { test } from "node:test";
import { prepareOwnedWorkflowCandidate } from "./fixtures/prepare-owned-workflow.mjs";
import { runOwnedExecutionSdk } from "./fixtures/run-owned-execution-sdk.mjs";
test("real scoped workflow: pre-spawn lineage, controller exit and mixed-child closure", { timeout: 120000 },
	(t) => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedWorkflowCandidate, expectWorkflowClosure: true }));
test("real controller owner crash never seals its roster on reload", { timeout: 120000 },
	(t) => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedWorkflowCandidate, controllerCrash: true }));
