import { QoderError } from './auth.mjs';
import { MODEL, PROVIDER_ID, createQoderProvider } from './provider.mjs';
import { CREDIT_ENTRY } from './credits.mjs';
import { abortable, SUPPORTED_MODEL_IDS } from './transport.mjs';

async function refreshRegistry(ctx, { force = false, signal } = {}) {
  const deadline = AbortSignal.timeout(30000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const result = await abortable(() => ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: true, force, signal: bounded }), bounded);
    if (result.aborted || result.errors.has(PROVIDER_ID)) throw new QoderError('catalog_refresh_failed');
  } catch {
    // Registry/provider errors can contain private upstream bodies. Keep the
    // stream error stable and non-retryable, with actionable help in the UI.
    throw new QoderError(signal?.aborted ? 'aborted' : 'catalog_refresh_failed');
  }
}

export function qoderEnabled(env = process.env) {
  if (env.ROTOM_QODER === undefined || env.ROTOM_QODER === '0') return false;
  if (env.ROTOM_QODER !== '1') throw new QoderError('invalid_opt_in');
  return true;
}

export const BINDING_TYPE = 'qoder-experimental-account-v1';
const fingerprintValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Account ownership covers the whole session tree, not just the active branch.
// A custom entry survives compaction without entering model context.
export function bindSessionAccount(manager, append, fingerprint) {
  if (!fingerprintValid(fingerprint)) throw new QoderError('credential_identity_unavailable');
  const entries = manager.getEntries();
  const bindings = entries.filter(e => e.type === 'custom' && e.customType === BINDING_TYPE);
  if (bindings.some(e => e.data?.version !== 1 || !fingerprintValid(e.data?.fingerprint))) throw new QoderError('account_binding_invalid');
  if (bindings.some(e => e.data.fingerprint !== fingerprint)) throw new QoderError('account_changed_start_new_session');
  if (bindings.length) return;
  // Never silently assign an old, unbound Qoder transcript to today's account.
  // Compacted legacy histories can hide provenance, so those fail closed too.
  if (entries.some(e => e.type === 'compaction' || (e.type === 'message' && e.message?.role === 'assistant' && e.message.provider === PROVIDER_ID && !['error', 'aborted'].includes(e.message.stopReason)))) throw new QoderError('legacy_session_unbound_start_new_session');
  append(BINDING_TYPE, { version: 1, fingerprint, pricing: 'unknown' });
  if (!manager.getEntries().some(e => e.type === 'custom' && e.customType === BINDING_TYPE && e.data?.fingerprint === fingerprint)) throw new QoderError('account_binding_not_saved');
}

export function installSessionPolicy(pi) {
  let current, catalogRefresh, epoch = 0;
  // Per an explicit maintainer choice there is no always-on Qoder footer status
  // line. Pi's TUI footer renders extension statuses as their own undimmed line
  // (layout owned by Pi, not exposable to extensions), so a merged/same-font line
  // is not achievable without forking Pi. Credits are still recorded in session
  // entries; the USD-unknown / $0-placeholder disclosure stays on the model name
  // ("(experimental; price unknown)") and the /qoder-credits snapshot.
  const attach = (_event, ctx) => { current = ctx; epoch++; };
  for (const event of ['session_start', 'before_agent_start', 'session_before_compact', 'session_before_tree']) pi.on(event, attach);
  pi.on('model_select', attach);
  pi.on('session_shutdown', () => { current = undefined; epoch++; });
  pi.on('message_end', (event, ctx) => {
    if (!ctx.hasUI || event.message?.provider !== PROVIDER_ID) return;
    const code = event.message.errorMessage?.match(/Qoder: ([a-z0-9_]+)/)?.[1];
    const help = {
      catalog_refresh_required: 'Qoder 模型目录尚未就绪。请运行 /qoder-models 刷新后再发送；本次未发送推理请求。',
      catalog_refresh_failed: 'Qoder 模型目录自动刷新未完成，本次未发送推理请求。请检查网络，用 /qoder-models 手动刷新；仅登录失效时重新登录并开启新会话。',
      catalog_changed_select_again: 'Qoder 模型目录或上下文能力已变化，本次未发送推理请求。请用 /model 重新选择模型。',
      catalog_model_unavailable: '当前 Qoder 模型已不在可用目录中，本次未发送推理请求。请用 /qoder-models 查看目录，再用 /model 选择可用模型。',
      catalog_account_mismatch: 'Qoder 目录与请求账号不一致，本次未发送推理请求。请恢复原账号；切换账号须开启新会话。',
      reasoning_controls_not_validated: '当前 Qoder 目录不支持所选思考档位，本次未发送推理请求。请用 /model 核对模型并选择受支持的思考档位。',
      credential_expired_login_with_qodercli: 'Qoder login expired. Log in normally with Qoder CLI using the SAME account, then submit again. No automatic refresh or replay occurred.',
      oauth_login_required: 'Qoder browser login expired. Use /login qoder-experimental, then start a new session.',
      oauth_refresh_unproven_login_required: 'Qoder refresh outcome is unproven. It will not be replayed. Use /login qoder-experimental, then start a new session.',
      oauth_refresh_already_attempted_login_required: 'This Qoder refresh token was already attempted. Re-login and start a new session; do not delete refresh-attempt guards to retry.',
      account_changed_start_new_session: 'Qoder account changed. Restore the original account or start a new session; existing history was not dispatched.',
      legacy_session_unbound_start_new_session: 'This legacy session has no Qoder account binding. Start a new session; do not silently attach old history to the current account.',
    };
    if (help[code]) ctx.ui.notify(help[code], 'warning');
  });
  const captureScope = expectedSessionId => {
    const ctx = current, capturedEpoch = epoch, sessionId = ctx?.sessionManager.getSessionId?.();
    return () => Boolean(ctx) && current === ctx && epoch === capturedEpoch && ctx.sessionManager.getSessionId?.() === sessionId && (expectedSessionId === undefined || expectedSessionId === sessionId);
  };
  const captureBinding = () => {
    const ctx = current, valid = captureScope();
    if (!ctx) throw new QoderError('account_binding_unavailable');
    return fingerprint => {
      if (!valid()) throw new QoderError('account_binding_stale');
      bindSessionAccount(ctx.sessionManager, (type, data) => pi.appendEntry(type, data), fingerprint);
    };
  };
  const captureMetering = () => {
    const ctx = current, valid = captureScope();
    return data => {
      if (!valid()) return;
      const entries = ctx.sessionManager.getEntries(), bindings = entries.filter(e => e.type === 'custom' && e.customType === BINDING_TYPE);
      if (!fingerprintValid(data.fingerprint) || !bindings.length || bindings.some(e => e.data?.version !== 1 || e.data?.fingerprint !== data.fingerprint)) return;
      if (!SUPPORTED_MODEL_IDS.includes(data.modelId) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(data.requestId ?? '')) return;
      const sessionId = ctx.sessionManager.getSessionId();
      if (entries.some(e => e.type === 'custom' && e.customType === CREDIT_ENTRY && e.data?.sessionId === sessionId && e.data?.requestId === data.requestId)) return;
      const selected = Object.fromEntries(['modelId', 'requestId', 'status', 'outcome', 'credits', 'billable', 'originalCredits'].filter(k => data[k] !== undefined).map(k => [k, data[k]]));
      pi.appendEntry(CREDIT_ENTRY, { version: 1, sessionId, ...selected });
    };
  };
  const refreshCatalog = async ({ signal } = {}) => {
    // Stream sessionId is a routing ID (compaction can mint its own), not the
    // session owner. Bind to lifecycle epoch + SessionManager identity instead.
    const ctx = current, valid = captureScope();
    if (!valid()) throw new QoderError('account_binding_stale');
    if (signal?.aborted) throw new QoderError('aborted');
    // Same-scope concurrent callers share one read. Cancellation of its owner
    // stops all waiters; none silently starts a replacement refresh or inference.
    if (!catalogRefresh || !catalogRefresh.valid()) {
      const pending = { valid, promise: refreshRegistry(ctx, { signal }) };
      catalogRefresh = pending;
      void pending.promise.finally(() => {
        if (catalogRefresh === pending) catalogRefresh = undefined;
      }).catch(() => {});
    }
    const pending = catalogRefresh.promise;
    if (signal) await abortable(() => pending, signal);
    else await pending;
    if (!valid()) throw new QoderError('account_binding_stale');
    if (signal?.aborted) throw new QoderError('aborted');
  };
  return { captureBinding, captureMetering, captureScope, refreshCatalog };
}

export async function installQoderExtension(pi, options = {}) {
  const policy = installSessionPolicy(pi);
  const provider = await createQoderProvider({ ...options, captureBinding: policy.captureBinding, captureMetering: policy.captureMetering, refreshCatalog: policy.refreshCatalog });
  pi.registerProvider(provider);
  const refresh = async (ctx, force = false) => {
    try {
      await refreshRegistry(ctx, { force });
      if (force && ctx.hasUI) {
        const entries = provider.getCatalogStatus();
        ctx.ui.notify(entries.map(e => `${e.name} [${e.id}] — ${e.enabled && e.reviewed && e.format === 'openai' ? 'available (adapter limits apply)' : 'not enabled in adapter'}`).join('\n') || 'Qoder: log in before loading the catalog.', 'info');
      }
    } catch {
      if (ctx.hasUI) ctx.ui.notify('Qoder catalog refresh unavailable. No model request or retry was made. Log in, then use /qoder-models; existing catalog state was retained.', 'warning');
    }
  };
  pi.on('session_start', (_event, ctx) => refresh(ctx));
  pi.registerCommand('qoder-models', { description: 'Refresh account Qoder model catalog; show exact IDs and adapter availability', handler: (_args, ctx) => refresh(ctx, true) });
  // UI notification only, never a conversation message: account balances must
  // not enter normal prompts, compaction, branch summaries or resumed history.
  pi.registerCommand('qoder-credits', { description: 'Read current Qoder Credit pools; no model request or inferred request debit', handler: async (_args, ctx) => {
    if (!ctx.hasUI) throw new QoderError('quota_ui_unavailable');
    const valid = policy.captureScope(ctx.sessionManager.getSessionId());
    if (!valid()) throw new QoderError('quota_context_unavailable');
    try {
      // Auth resolution is provider-owned; quota does not require an enabled
      // model or change the user's current selection.
      const model = MODEL;
      const bindings = ctx.sessionManager.getEntries().filter(e => e.type === 'custom' && e.customType === BINDING_TYPE);
      if (bindings.some(e => e.data?.version !== 1 || !fingerprintValid(e.data?.fingerprint) || e.data.fingerprint !== bindings[0].data.fingerprint)) throw new QoderError('account_binding_invalid');
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!valid()) return;
      if (!auth.ok) throw new QoderError('quota_identity_unavailable');
      const snapshot = await provider.getQuotaUsage({ apiKey: auth.apiKey, expectedFingerprint: bindings[0]?.data?.fingerprint, signal: AbortSignal.timeout(15000) });
      if (!valid()) return;
      const lines = Object.entries(snapshot.pools).map(([name, pool]) => `${name}: ${pool ? `remaining ${pool.remaining ?? '?'} / ${pool.total ?? '?'} ${pool.unit} (used ${pool.used ?? '?'})` : 'not reported'}`);
      ctx.ui.notify(`Qoder Credit snapshot (${new Date(snapshot.observedAt).toISOString()})\n${lines.join('\n')}\nAccount snapshot only; shared/concurrent use may change it. Not per-request debit or USD cost.`, 'info');
    } catch {
      if (valid()) ctx.ui.notify('Qoder Credit snapshot unavailable. Check login/account and use a new session after an account change. No model request or retry was made.', 'warning');
    }
  } });
  return provider;
}
