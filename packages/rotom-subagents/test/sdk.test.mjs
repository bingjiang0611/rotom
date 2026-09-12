import test from 'node:test';
import {snapshot} from '../scripts/source.mjs';
import {runOwnedExecutionSdk} from '../../../rotom/extensions/third-party/fixtures/run-owned-execution-sdk.mjs';
const common={prepareCandidate:snapshot,expectWorkflowClosure:true,expectForegroundClosure:true,expectStoreIsolation:true};
test('maintained source preserves lost-controller occupancy and acknowledgment fence',{timeout:120000},t=>runOwnedExecutionSdk(t,{...common,expectSessionIsolation:true,usePublicEntry:true,controllerCrash:true}));
test('maintained source rejects unsupported routes before any writer',{timeout:120000},t=>runOwnedExecutionSdk(t,{...common,expectFlatAdmission:true}));
test('maintained source preserves all admitted public-entry SDK paths',{timeout:120000},t=>runOwnedExecutionSdk(t,{...common,expectSessionIsolation:true,usePublicEntry:true}));
