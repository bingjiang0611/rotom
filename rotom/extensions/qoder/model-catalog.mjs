import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { QoderError } from './auth.mjs';
import { BASE_URL, SUPPORTED_MODEL_IDS, REASONING_MODEL_IDS, VERIFIED_THINKING_LEVELS, EXPANDED_INPUT_MODEL_IDS, inputCapabilities } from './transport.mjs';

// What this provider declares before any catalog exists: the two offline baseline
// identities, the reviewed thinking levels, and the native output-budget probe. It
// lives here so provider.mjs stays the request/payload surface.

export const PROVIDER_ID = 'qoder';
export const MODEL = {
  id: 'lite', name: 'Qoder Lite',
  // Self-owned api identity: the extension builds the request payload and
  // translates the response itself (messages.mjs + translate.mjs), so sessions
  // are pinned to "qoder" and never share replay history with the former
  // "openai-completions" identity. Older sessions fail model_scope by design.
  api: 'qoder', provider: PROVIDER_ID, baseUrl: BASE_URL,
  reasoning: false, input: ['text'],
  // Managed input window; zero means no declared output maximum in Pi.
  // The service owns the default output budget, not a guessed adapter cap.
  contextWindow: 32000, maxTokens: 0,
  // Pi requires numeric prices. These placeholders are NOT zero-cost evidence.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: 'max_tokens' },
};

// Offline baseline retains the two historical identities; named labels come from discovery.
export const MODELS = Object.freeze(['lite', 'performance'].map(id => Object.freeze({
  ...MODEL, id, name: `Qoder ${id === 'lite' ? 'Lite' : 'Performance'}`,
})));

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function controlsFor(entry, declared = false) {
  const reviewed = VERIFIED_THINKING_LEVELS[entry?.id];
  if (!reviewed || !declared && !entry.reportedThinking) return;
  const levels = reviewed.filter(level => declared || (level === 'off' ? entry.reportedThinking.disabled : entry.reportedThinking.efforts.includes(level)));
  if (!levels.length) return;
  return { levels, defaultLevel: levels.includes(entry.reportedThinking?.defaultEffort) ? entry.reportedThinking.defaultEffort : levels.find(l => l !== 'off') ?? 'off' };
}
export const thinkingMap = levels => Object.freeze(Object.fromEntries(THINKING_LEVELS.map(l => [l, levels.includes(l) ? l === 'off' ? 'none' : l : null])));
export function catalogModel(entry, declared = false) {
  const declaredExpanded = declared && EXPANDED_INPUT_MODEL_IDS.includes(entry.id);
  const { id, name, contextWindow = declaredExpanded ? 272000 : 32000 } = entry, reasoning = REASONING_MODEL_IDS.includes(id), controls = controlsFor(entry, declared);
  return Object.freeze({ ...MODEL, id, name: `Qoder ${name}`, contextWindow, reasoning, input: Object.freeze(declaredExpanded || inputCapabilities(entry).images ? ['text', 'image'] : ['text']),
    ...(reasoning ? { thinkingLevelMap: controls ? thinkingMap(controls.levels) : { off: null, minimal: null, low: null, medium: 'enabled', high: null, xhigh: null, max: null } } : {}),
    ...(controls ? { compat: { ...MODEL.compat, supportsReasoningEffort: true } } : {}),
  });
}
// Pi selects an explicit/resumed model before session_start; refreshing the
// provider catalog does not replace that session's selected model object. Declare
// reviewed upper bounds here so native image/budget gates see them at startup,
// without programmatically reselecting the user's model or thinking level.
// Availability still filters to the baseline until discovery. Current-account
// dispatch gates reject absent/narrowed capabilities, including stale maxima.
export const DECLARED_MODELS = Object.freeze(SUPPORTED_MODEL_IDS.map(id => MODELS.find(m => m.id === id) ?? catalogModel({ id, name: `${id} [catalog required]` }, true)));

// Pi's extension loader aliases the ai root to compat.js, so importing an
// arbitrary ai subpath through jiti would become compat.js/api/…. Resolve the
// public export from the launcher-verified Pi (or explicit SDK probe Pi), never
// from the business cwd or an unrelated global installation.
export async function nativeOutputBudget() {
  const executable = process.env.ROTOM_VERIFIED_PI_EXECUTABLE ?? process.env.ROTOM_PI;
  if (!executable || !isAbsolute(executable)) throw new QoderError('pi_budget_runtime_unavailable');
  const metadata = findPackageJSON('@earendil-works/pi-ai/api/simple-options', pathToFileURL(executable));
  const pkg = JSON.parse(await readFile(metadata, 'utf8'));
  const exported = pkg.exports?.['./api/*']?.import;
  if (pkg.name !== '@earendil-works/pi-ai' || exported !== './dist/api/*.js') throw new QoderError('pi_budget_runtime_unavailable');
  return (await import(new URL(exported.replace('*', 'simple-options'), pathToFileURL(metadata)).href)).clampMaxTokensToContext;
}
