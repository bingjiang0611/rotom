import test from "node:test";
import { prepareOwnedSessionCandidate } from "./fixtures/prepare-owned-session.mjs";
import { runOwnedExecutionSdk } from "./fixtures/run-owned-execution-sdk.mjs";
test("real public SDK rejects config-only scope selection with the session candidate", { timeout: 120000 }, t => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedSessionCandidate, expectStoreMismatch: true }));
test("real controller crash retains v3 store occupancy after restart", { timeout: 120000 }, t => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedSessionCandidate, expectWorkflowClosure: true, expectForegroundClosure: true, expectStoreIsolation: true, controllerCrash: true }));
test("real public SDK preserves scoped operations with isolated sessions and opaque leases", { timeout: 120000 }, t => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedSessionCandidate, expectWorkflowClosure: true, expectForegroundClosure: true, expectStoreIsolation: true, expectSessionIsolation: true }));
