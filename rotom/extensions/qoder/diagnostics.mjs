// Qoder owns translation from private/provider-specific failures into the
// already-sanitized metadata contract consumed by optional observers.
const SUMMARY_FAILURE_PREFIX = /^Compaction failed: (?:[A-Za-z ]+ failed: )?/u;
const LEADING_HTTP_STATUS = /^([45]\d\d)\b/u;
const ERROR_CATEGORIES = [
  ['timeout', /timed out|\btimeout\b/iu],
  ['websocket', /^WebSocket (?:error|closed)\b/u],
  ['aborted', /^This operation was aborted$/u],
  ['overloaded', /overloaded/iu],
  ['network', /^(?:fetch failed|terminated|Connection error\.)(?: \(caused by: .*\))?$|^Qoder: (?:request|stream|connection)_failed$|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|socket hang up|^upstream connect error/u],
  ['auth', /^API key auth failed\b/u],
  ['provider_error', /^Codex error:|^\{"type":"error"|^Qoder: /u],
];
const ERROR_CODES = new Set([
  'upstream_error_event', 'upstream_error_frame', 'request_failed', 'connection_failed',
  'stream_failed', 'invalid_tool_id', 'invalid_tool_arguments', 'model_refusal',
]);
const DIAGNOSTIC_CODES = new Set(['upstream_error_frame', 'legacy_error', 'transport_failure', 'invalid_tool_id', 'invalid_tool_arguments']);
const safe = (value, max = 256) => typeof value === 'string' && value ? value.slice(0, max) : undefined;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

export const PROVIDER_METADATA_EVENT = 'rotom:provider:metadata:v1';

export function qoderErrorAttributes(errorMessage, httpStatus) {
  const raw = typeof errorMessage === 'string' ? errorMessage.replace(SUMMARY_FAILURE_PREFIX, '').trim() : '';
  const status = Number(LEADING_HTTP_STATUS.exec(raw)?.[1])
    || Number(raw.match(/^Qoder: http_([45]\d\d)$/u)?.[1])
    || (Number.isSafeInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? httpStatus : undefined);
  const code = safe(raw.match(/^Qoder: ([a-z0-9_]+)$/u)?.[1]);
  const normalizedCode = ['request_failed', 'connection_failed', 'stream_failed'].includes(code) ? 'transport_failure' : code;
  const category = status
    ? 'http'
    : ERROR_CATEGORIES.find(([, pattern]) => pattern.test(raw))?.[0] ?? 'unknown';
  return {
    ...(normalizedCode && (ERROR_CODES.has(code) || normalizedCode === 'transport_failure') ? { 'pi.ai.qoder.error_code': normalizedCode } : {}),
    'pi.ai.error.category': category,
    ...(status ? { 'pi.ai.error.http_status': status } : {}),
  };
}

export function qoderDiagnosticAttributes(value) {
  const diagnostic = record(value);
  const code = diagnostic?.code;
  if (!diagnostic || !DIAGNOSTIC_CODES.has(code)) return {};
  if (code === 'invalid_tool_arguments') {
    return {
      'pi.ai.qoder.diagnostic_code': code,
      ...(['invalid_json', 'non_object'].includes(diagnostic.reason) ? { 'pi.ai.qoder.tool_arguments_reason': diagnostic.reason } : {}),
      ...(Number.isSafeInteger(diagnostic.argumentBytes) && diagnostic.argumentBytes >= 0 ? { 'pi.ai.qoder.tool_arguments_bytes': diagnostic.argumentBytes } : {}),
    };
  }
  if (code === 'invalid_tool_id') {
    return {
      'pi.ai.qoder.diagnostic_code': code,
      ...(['non_string', 'oversized', 'changed'].includes(diagnostic.reason) ? { 'pi.ai.qoder.tool_id_reason': diagnostic.reason } : {}),
      ...(diagnostic.reason === 'changed' && ['extension', 'fragment', 'distinct'].includes(diagnostic.relation) ? { 'pi.ai.qoder.tool_id_relation': diagnostic.relation } : {}),
      ...(diagnostic.reason === 'changed' && typeof diagnostic.previousArgumentsComplete === 'boolean' ? { 'pi.ai.qoder.previous_arguments_complete': diagnostic.previousArgumentsComplete } : {}),
      ...(Number.isSafeInteger(diagnostic.wireIndex) && diagnostic.wireIndex >= 0 && diagnostic.wireIndex < 64 ? { 'pi.ai.qoder.tool_wire_index': diagnostic.wireIndex } : {}),
    };
  }
  const status = Number.isSafeInteger(diagnostic.status) && diagnostic.status >= 0 ? diagnostic.status : undefined;
  const httpStatus = status >= 400 && status <= 599 ? status : undefined;
  const allowedCategories = ['tool', 'content', 'null', 'reasoning', 'model', 'parameter', 'quota', 'permission', 'invalid'];
  const categories = code === 'legacy_error' && Array.isArray(diagnostic.categories)
    ? allowedCategories.filter(category => diagnostic.categories.includes(category)) : [];
  const phase = code === 'transport_failure' && ['request', 'stream'].includes(diagnostic.phase) ? diagnostic.phase : undefined;
  return {
    'pi.ai.qoder.diagnostic_code': code,
    ...(status !== undefined ? { 'pi.ai.qoder.frame_status_code': status } : {}),
    ...(httpStatus !== undefined ? { 'pi.ai.error.category': 'http', 'pi.ai.error.http_status': httpStatus } : {}),
    ...(code === 'upstream_error_frame' && typeof diagnostic.hasError === 'boolean' ? { 'pi.ai.qoder.frame_has_error': diagnostic.hasError } : {}),
    ...(categories.length ? { 'pi.ai.qoder.error_categories': categories } : {}),
    ...(phase ? { 'pi.ai.qoder.transport_phase': phase } : {}),
  };
}

export function qoderMetadataForError(error, httpStatus) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return qoderErrorAttributes(message, httpStatus);
}
