import test from "node:test";
import { prepareOwnedStoreCandidate } from "./fixtures/prepare-owned-store.mjs";
import { runOwnedExecutionSdk } from "./fixtures/run-owned-execution-sdk.mjs";
test("real public SDK rejects config-only scope selection before any writer starts", { timeout: 120000 }, t => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedStoreCandidate, expectStoreMismatch: true }));
test("real public SDK preserves owned closure in the explicitly initialized store", { timeout: 120000 }, t => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedStoreCandidate, expectWorkflowClosure: true, expectForegroundClosure: true, expectStoreIsolation: true }));
test("real controller crash cannot reset a scoped store's capacity", { timeout: 120000 }, t => runOwnedExecutionSdk(t, { prepareCandidate: prepareOwnedStoreCandidate, expectWorkflowClosure: true, expectForegroundClosure: true, expectStoreIsolation: true, controllerCrash: true }));
