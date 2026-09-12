import { test } from "node:test";
import { prepareOwnedExecutionCandidate } from "./fixtures/prepare-owned-execution.mjs";
import { runOwnedExecutionSdk } from "./fixtures/run-owned-execution-sdk.mjs";
test("real scoped executor: sequential capacity, stop, escape and mixed Pi workflow", { timeout: 120000 },
	(t) => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedExecutionCandidate }));
