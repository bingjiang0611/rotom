import { readLocalCredential, createCredentialAccess, QoderError } from './auth.mjs';
import { BASE_URL, SUPPORTED_MODEL_IDS, REASONING_MODEL_IDS, openQoderStream, abortable, validateReasoningSignature, OPAQUE_MODEL_IDS, VERIFIED_THINKING_LEVELS, EXPANDED_INPUT_MODEL_IDS, inputCapabilities, imageByteLength } from './transport.mjs';
import { buildQoderPayload, isSameModelAssistant } from './messages.mjs';
import { beforeOutputError, translateQoderStream } from './translate.mjs';
import { catalogMetadata, fetchCatalog, parseCatalogMetadata, CATALOG_TTL_MS } from './catalog.mjs';
import { createBrowserOAuth, createOAuthEnvelope } from './oauth.mjs';
import { fetchQuota } from './credits.mjs';
import { qoderMetadataForError } from './diagnostics.mjs';
import { DECLARED_MODELS, MODEL, MODELS, PROVIDER_ID, catalogModel, controlsFor, nativeOutputBudget, thinkingMap } from './model-catalog.mjs';

// The declared model shape lives in model-catalog.mjs; these stay exported from
// here because every caller and test imports them from the provider entry point.
export { MODEL, MODELS, PROVIDER_ID };

export async function createQoderProvider({ piAI, clampMaxTokens, getToken, getCredential, captureBinding, captureMetering, fetchImpl, onDiagnostic, onMetadata, onMetering,
  authMode = process.env.ROTOM_QODER_AUTH ?? 'browser', oauthOptions = {}, refreshCatalog, onCatalogStaleReuse } = {}) {
  if (!['browser', 'qodercli'].includes(authMode)) throw new QoderError('invalid_auth_mode');
  const envelope = authMode === 'browser' ? createOAuthEnvelope() : undefined;
  let browserFingerprint;
  const browserBinding = captureBinding ?? (() => fingerprint => {
    if (browserFingerprint && browserFingerprint !== fingerprint) throw new QoderError('account_changed_start_new_session');
    browserFingerprint = fingerprint;
  });
  piAI ??= await import('@earendil-works/pi-ai');
  const authDir = process.env.ROTOM_QODER_AUTH_DIR;
  let catalogState, observedCLI;
  const sourceCLI = getCredential ?? (!getToken ? () => readLocalCredential({ authDir }) : undefined);
  const readCLI = sourceCLI ? async signal => { const c = await sourceCLI(signal); observedCLI = c.fingerprint; return c; } : undefined;
  const baseline = id => MODELS.some(m => m.id === id);
  const currentModels = () => catalogState?.models ?? DECLARED_MODELS;
  const checkCatalog = (credential, id, snapshot, staleReuse = false) => {
    if (snapshot !== catalogState) throw new QoderError('catalog_changed_select_again');
    if (baseline(id) && (!snapshot || snapshot.fingerprint !== credential.fingerprint)) return;
    // A stale catalog reused after a failed refresh still belongs to this account; an
    // account switch must never be served from it.
    if ((!snapshot || snapshot.expiresAt <= Date.now()) && !staleReuse) throw new QoderError('catalog_refresh_required');
    if (snapshot.fingerprint !== credential.fingerprint) throw new QoderError('catalog_account_mismatch');
    if (!snapshot.models.some(m => m.id === id)) throw new QoderError('catalog_model_unavailable');
  };
  let checkAuth = getToken;
  if (!getToken && !envelope) {
    const access = createCredentialAccess({ readCredential: readCLI, captureBinding: browserBinding });
    getToken = access.getToken; checkAuth = access.check;
  }
  const publishTerminalError = (error, status) => {
    try { onMetadata?.(qoderMetadataForError(error, status)); } catch { /* Optional diagnostics cannot alter inference. */ }
  };
  const prepare = async (method, model, context, options) => {
    // Pi 1.0 carries prompt/tool deltas in system messages. Qoder's wire API
    // needs one current prompt and tool set; replay through Pi's native helpers
    // so deferred tools and removals are neither lost nor resurrected.
    const transcript = piAI.normalizeContext(context);
    context = {
      systemPrompt: piAI.getCurrentSystemPrompt(transcript.messages),
      tools: piAI.getCurrentTools(transcript.messages),
      messages: transcript.messages.filter(message => message.role !== 'system'),
    };
    const reasoning = REASONING_MODEL_IDS.includes(model.id);
    if (!SUPPORTED_MODEL_IDS.includes(model.id) || model.provider !== PROVIDER_ID || model.baseUrl !== BASE_URL || model.api !== MODEL.api || model.reasoning !== reasoning || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 4096 || model.contextWindow > (EXPANDED_INPUT_MODEL_IDS.includes(model.id) ? 272000 : 32000) || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 0) throw new QoderError('model_scope_rejected');
    if (options.signal?.aborted) throw new QoderError('aborted');
    // Refresh through the session's native registry before building any payload,
    // including tool continuations and compaction. Never retry an inference.
    // Standalone/offline providers without this seam retain explicit discovery.
    let staleReuse = false;
    if (refreshCatalog && (catalogState ? catalogState.expiresAt <= Date.now() : !baseline(model.id))) {
      try {
        await refreshCatalog({ signal: options.signal });
      } catch (error) {
        // Only a refresh that failed on its own is absorbed. A cancelled run, a replaced
        // session or an account change must still stop here, before any dispatch.
        if (!(error instanceof QoderError) || error.code !== 'catalog_refresh_failed') throw error;
        // Such a failure must not cost the request its retry budget: the last catalog we
        // validated still describes this account. With no snapshot there is nothing to serve.
        if (!catalogState) throw error;
        staleReuse = true;
        try { onCatalogStaleReuse?.(error); } catch { /* A notice cannot change inference. */ }
      }
    }
    if (options.signal?.aborted) throw new QoderError('aborted');
    const snapshot = catalogState;
    if ((!baseline(model.id) && !snapshot) || (snapshot?.expiresAt <= Date.now() && !staleReuse)) throw new QoderError('catalog_refresh_required');
    if (snapshot && !snapshot.models.some(m => m.id === model.id)) throw new QoderError('catalog_model_unavailable');
    const entry = snapshot?.entries.find(e => e.id === model.id), controls = controlsFor(entry), input = inputCapabilities(entry);
    if (model.contextWindow > input.contextWindow) throw new QoderError('catalog_changed_select_again');
    let reasoningMode;
    // Simple API encodes a selected off as an omitted option. If refreshed
    // capabilities remove off, do not reinterpret it as the server default/on.
    if (reasoning && model.thinkingLevelMap?.off != null && options.reasoning === undefined && options.reasoningEffort === undefined && !controls?.levels.includes('off')) throw new QoderError('catalog_changed_select_again');
    if (controls) {
      const key = method === 'streamSimple' ? 'reasoning' : 'reasoningEffort', other = method === 'streamSimple' ? 'reasoningEffort' : 'reasoning';
      if (options[other] !== undefined || options.thinkingBudgets !== undefined) throw new QoderError('reasoning_controls_not_validated');
      // Pi represents off by an omitted reasoning option. Models without an off
      // control retain their catalog default when SDK callers omit the option.
      const requested = options[key] ?? (controls.levels.includes('off') ? 'off' : controls.defaultLevel), level = requested === 'none' ? 'off' : requested;
      if (method === 'streamSimple' && requested === 'none' || !controls.levels.includes(level)) throw new QoderError('reasoning_controls_not_validated');
      reasoningMode = Object.freeze({ enabled: level !== 'off', effort: level === 'off' ? 'none' : level });
    } else if (reasoning ? (options.reasoning && options.reasoning !== 'medium') || options.reasoningEffort : options.reasoning || options.reasoningEffort) throw new QoderError('reasoning_controls_not_validated');
    for (const message of context.messages) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'image') {
          if (!input.images || !['user', 'toolResult'].includes(message.role)) throw new QoderError('images_not_validated');
          imageByteLength(block.data, block.mimeType);
        }
        // The builder removes foreign assistant signatures, retaining visible
        // text and tool/result pairing. Validate only signatures it can replay;
        // image gates above and post-hook wire validation are never bypassed.
        if (message.role === 'assistant' && !isSameModelAssistant(message, model)) continue;
        if (block.type === 'toolCall' && block.thoughtSignature) throw new QoderError('opaque_reasoning_replay_unsupported');
        if (block.type !== 'thinking' || !block.thinkingSignature) continue;
        if (message.role !== 'assistant') throw new QoderError('opaque_reasoning_replay_unsupported');
        if (reasoning && block.thinkingSignature === 'reasoning_content') continue;
        if (!OPAQUE_MODEL_IDS.includes(model.id)) throw new QoderError('opaque_reasoning_replay_unsupported');
        validateReasoningSignature(block.thinkingSignature, model.id);
      }
    }
    let requestCredential, recordMetering;
    try { recordMetering = captureMetering?.(); } catch { /* Optional accounting cannot bypass or block the binding gate. */ }
    const requestToken = envelope || readCLI ? createCredentialAccess({
      readCredential: async signal => {
        const c = envelope ? envelope.read(options.apiKey) : await readCLI(signal);
        checkCatalog(c, model.id, snapshot, staleReuse);
        requestCredential = c;
        return c;
      }, captureBinding: browserBinding,
    }).getToken : getToken;
    // Model requests have no provider-owned deadline. The caller's AbortSignal
    // remains the only local cancellation source, so long reasoning streams can
    // run to their upstream completion without a fixed wall-clock cutoff.
    // Native model view: corrected image capability and thinking controls for
    // request building and the persisted message identity. Pi retains
    // serialization, tool execution, context/branch management and the rest of
    // the agent lifecycle; only request encoding and response translation move
    // in-house here.
    const nativeModel = { ...model, contextWindow: input.contextWindow, input: input.images ? ['text', 'image'] : ['text'], ...(controls ? { thinkingLevelMap: thinkingMap(controls.levels), compat: { ...MODEL.compat, supportsReasoningEffort: true } } : {}) };
    // Omit the default output limit, including for resumed models that still
    // carry the former 4096 metadata. Explicit caller budgets (e.g. compaction)
    // still use Pi's context headroom rather than an independent fixed ceiling.
    let maxTokens;
    if (options.maxTokens !== undefined) {
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) throw new QoderError('request_limits_rejected');
      clampMaxTokens ??= await nativeOutputBudget();
      maxTokens = clampMaxTokens(nativeModel, context, options.maxTokens);
    }
    let payload = buildQoderPayload(nativeModel, context, { maxTokens, reasoningMode });
    // Preserve Pi's BeforeProviderRequest hook: an extension may rewrite the
    // payload, but openQoderStream re-validates the result against the bound
    // model contract, so a hook cannot smuggle an unsupported modality, a
    // different effort, or a credential/endpoint override past the gate.
    const hookedPayload = await options.onPayload?.(payload, nativeModel);
    if (hookedPayload !== undefined) payload = hookedPayload;
    // openQoderStream performs the single authoritative request validation, wire
    // encoding and HTTP dispatch, then yields validated chunk records; a
    // pre-stream failure rejects here and lazyStream turns it into an error
    // event carrying the stable "Qoder: <code>" message the session-policy reads.
    let responseStatus, terminalMetadataPublished = false;
    const reportDiagnostic = diagnostic => {
      const status = Number.isSafeInteger(diagnostic?.status) && diagnostic.status >= 400 ? diagnostic.status : undefined;
      const result = onDiagnostic?.(diagnostic);
      if (diagnostic?.code === 'upstream_error_frame' && status !== undefined) {
        publishTerminalError(new QoderError('upstream_error_frame'), status);
        terminalMetadataPublished = true;
      }
      return result;
    };
    const { chunks } = await openQoderStream({ payload, getToken: requestToken, getLegacyCredential: () => requestCredential, legacyModel: entry, reasoningMode, fetchImpl, signal: options.signal, modelId: model.id, onDiagnostic: reportDiagnostic, sessionId: options.sessionId, onResponse: response => {
      responseStatus = response.status;
      return options.onResponse?.(response, model);
    }, onMetering(data) {
      for (const notify of [() => recordMetering?.({ ...data, fingerprint: requestCredential?.fingerprint }), () => onMetering?.(data)]) {
        try { void Promise.resolve(notify()).catch(() => {}); } catch { /* Scoped metadata only; never retry a model request. */ }
      }
    } });
    return translateQoderStream(chunks, model, { onError: error => {
      if (!terminalMetadataPublished) publishTerminalError(error, responseStatus);
    } });
  };
  const wrap = method => (model, context, options = {}) => piAI.lazyStream(model, async () => {
    try { return await prepare(method, model, context, options); }
    catch (caught) {
      // Setup failures happen before any response content exists.
      const error = beforeOutputError(caught);
      // Pi lazyStream labels setup exceptions as errors. Publish bounded metadata
      // before the synthetic stream delivers its terminal error event.
      publishTerminalError(error);
      if (!(error instanceof QoderError) || error.code !== 'aborted') throw error;
      return translateQoderStream((async function* () { throw error; })(), model, { onError: terminal => publishTerminalError(terminal) });
    }
  });
  const provider = piAI.createProvider({
    id: PROVIDER_ID, name: 'Qoder', baseUrl: BASE_URL,
    models: DECLARED_MODELS,
    auth: envelope ? { oauth: { ...createBrowserOAuth(oauthOptions), toAuth: envelope.toAuth } } : { apiKey: {
      name: 'Read-only Qoder CLI login (no automatic refresh)',
      async resolve({ signal } = {}) {
        const deadline = AbortSignal.timeout(60000);
        await abortable(checkAuth, signal ? AbortSignal.any([signal, deadline]) : deadline);
        // Never hand the real token to Pi's overrides, hooks or credential store.
        return { auth: { apiKey: 'local-qoder-auth-resolved-at-dispatch' }, source: 'Qoder CLI local login, read-only' };
      },
    } },
    api: { stream: wrap('stream'), streamSimple: wrap('streamSimple') },
  });
  // Use the same ModelsStore publication seam as other dynamic providers. The
  // non-secret scope prevents a cached account catalog from crossing identities.
  return {
    ...provider, getModels: currentModels,
    filterModels(models, credential) {
      // A filter must never reintroduce a model removed by the caller/config.
      if (!catalogState) return models.filter(m => baseline(m.id));
      const fingerprint = envelope ? credential?.fingerprint : observedCLI;
      if (fingerprint !== catalogState.fingerprint) return models.filter(m => baseline(m.id));
      // Keep a stale disk catalog selectable while refresh is attempted. Dispatch
      // still requires a fresh catalog through prepare/checkCatalog.
      return models;
    },
    async refreshModels(context) {
      if (context.signal.aborted) return;
      let c;
      try {
        if (envelope) {
          const auth = await envelope.toAuth(context.credential);
          c = envelope.read(auth.apiKey);
        } else {
          if (!readCLI) throw new QoderError('catalog_identity_unavailable');
          c = await abortable(readCLI, context.signal);
        }
      } catch (error) {
        // Cache-only initialization without a configured credential must remain
        // equivalent to every other unavailable provider.
        if (!context.allowNetwork) return;
        throw error;
      }
      if (!catalogState && context.stored?.scope === c.fingerprint) {
        let entries;
        try { entries = parseCatalogMetadata(context.stored.metadata); } catch { entries = undefined; }
        if (entries) {
          const models = Object.freeze(entries.filter(e => e.enabled && e.reviewed && e.format === 'openai').map(e => catalogModel(e)));
          const checkedAt = Number.isSafeInteger(context.stored.checkedAt) ? context.stored.checkedAt : 0;
          if (!(await context.publish({ update: () => { catalogState = { fingerprint: c.fingerprint, expiresAt: checkedAt + CATALOG_TTL_MS, entries, models }; } }))) return;
        }
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      if (!context.force && catalogState?.fingerprint === c.fingerprint && catalogState.expiresAt > Date.now()) return;
      const entries = await fetchCatalog(c, { fetchImpl, signal: context.signal });
      const models = Object.freeze(entries.filter(e => e.enabled && e.reviewed && e.format === 'openai').map(e => catalogModel(e)));
      if (context.signal.aborted) return;
      const checkedAt = Date.now();
      await context.publish({
        persist: { models, checkedAt, scope: c.fingerprint, metadata: catalogMetadata(entries) },
        update: () => { catalogState = { fingerprint: c.fingerprint, expiresAt: checkedAt + CATALOG_TTL_MS, entries, models }; },
      });
    },
    async getQuotaUsage({ apiKey, expectedFingerprint, signal } = {}) {
      const deadline = AbortSignal.timeout(15000), bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      if (!envelope && !readCLI) throw new QoderError('quota_identity_unavailable');
      const c = envelope ? envelope.read(apiKey) : await abortable(readCLI, bounded);
      if (expectedFingerprint && expectedFingerprint !== c.fingerprint) throw new QoderError('account_changed_start_new_session');
      return fetchQuota(c, { fetchImpl, signal: bounded });
    },
    // Metadata only for the explicit command; never return credentials/raw bodies.
    getCatalogStatus: () => catalogState?.entries ?? [],
  };
}
