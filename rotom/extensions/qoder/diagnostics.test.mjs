import assert from 'node:assert/strict';
import test from 'node:test';
import { qoderDiagnosticAttributes, qoderErrorAttributes } from './diagnostics.mjs';

test('Qoder diagnostic producer keeps only exact metadata enums and finite counts', () => {
  const raw = { code: 'invalid_tool_id', reason: 'changed', relation: 'PRIVATE_BODY', wireIndex: 65, previousArgumentsComplete: 'PRIVATE_BODY', secret: 'PRIVATE_BODY' };
  assert.deepEqual(qoderDiagnosticAttributes(raw), { 'pi.ai.qoder.diagnostic_code': 'invalid_tool_id', 'pi.ai.qoder.tool_id_reason': 'changed' });
  assert.deepEqual(qoderDiagnosticAttributes({ code: 'PRIVATE_BODY', error: 'PRIVATE_BODY' }), {});
  assert.deepEqual(qoderDiagnosticAttributes({ code: 'invalid_tool_arguments', reason: 'PRIVATE_BODY', argumentBytes: Infinity }), { 'pi.ai.qoder.diagnostic_code': 'invalid_tool_arguments' });
  assert.equal(qoderDiagnosticAttributes({ code: 'upstream_error_frame', status: 0 })['pi.ai.error.category'], undefined);
  assert.equal(qoderErrorAttributes('Qoder: request_failed')['pi.ai.error.category'], 'network');
  assert.equal(qoderErrorAttributes('Qoder: model_refusal')['pi.ai.qoder.error_code'], 'model_refusal');
  assert.doesNotMatch(JSON.stringify(qoderErrorAttributes('PRIVATE_BODY')), /PRIVATE_BODY/);
});
