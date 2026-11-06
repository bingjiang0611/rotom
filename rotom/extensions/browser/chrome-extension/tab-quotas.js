// Per-agent and global tab quotas.
//
// Only the service worker sees every session, so it is the one place that can count
// agent tabs globally. It refuses an `open` that would exceed a limit and names the
// limit, the current count and what to do instead; it never queues the request.

export const DEFAULT_BROWSER_TAB_QUOTAS_V1 = Object.freeze({
	maxAgents: 8,
	maxTabsPerAgent: 4,
	maxTabs: 24,
	maxTabsPerOrigin: 2,
});

/** Environment overrides read by the client and sent in `hello`. */
export const BROWSER_TAB_QUOTA_ENV_V1 = Object.freeze({
	maxAgents: "ROTOM_BROWSER_MAX_AGENTS",
	maxTabsPerAgent: "ROTOM_BROWSER_MAX_TABS_PER_AGENT",
	maxTabs: "ROTOM_BROWSER_MAX_TABS",
	maxTabsPerOrigin: "ROTOM_BROWSER_MAX_TABS_PER_ORIGIN",
});

export const BROWSER_TAB_QUOTA_KEYS_V1 = Object.freeze(Object.keys(DEFAULT_BROWSER_TAB_QUOTAS_V1));
const MAX_QUOTA_VALUE = 1_000;

/** Validated quotas, or undefined when any present field is not a sane integer. */
export function sanitizeBrowserTabQuotasV1(value) {
	if (value === undefined) return { ...DEFAULT_BROWSER_TAB_QUOTAS_V1 };
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const quotas = { ...DEFAULT_BROWSER_TAB_QUOTAS_V1 };
	for (const key of BROWSER_TAB_QUOTA_KEYS_V1) {
		if (value[key] === undefined) continue;
		// 0 is meaningful: it forbids that dimension outright.
		if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > MAX_QUOTA_VALUE) return undefined;
		quotas[key] = value[key];
	}
	return quotas;
}

/**
 * Read the operator's overrides. A malformed value is reported, not silently
 * replaced by the default, because a wrong quota is a policy change.
 */
export function browserTabQuotasFromEnvV1(env = {}) {
	const overrides = {};
	for (const key of BROWSER_TAB_QUOTA_KEYS_V1) {
		const raw = env[BROWSER_TAB_QUOTA_ENV_V1[key]];
		if (raw === undefined || raw === "") continue;
		const trimmed = String(raw).trim();
		const parsed = /^\d{1,4}$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
		if (!Number.isInteger(parsed) || parsed > MAX_QUOTA_VALUE) throw new Error(`${BROWSER_TAB_QUOTA_ENV_V1[key]} 必须是 0–${MAX_QUOTA_VALUE} 的整数（当前 ${JSON.stringify(String(raw))}）`);
		overrides[key] = parsed;
	}
	const quotas = sanitizeBrowserTabQuotasV1(overrides);
	if (!quotas) throw new Error("browser tab 配额取值超出范围；请检查 ROTOM_BROWSER_MAX_* 环境变量");
	return quotas;
}

/**
 * One `open` decision.
 *
 * @param {object} input
 * @param {object} input.quotas
 * @param {number} input.agentIndex      0-based connect order of the requesting agent
 * @param {number} input.agents          connected agent sessions
 * @param {number} input.ownTabs         tabs this agent opened itself
 * @param {number} input.globalTabs      agent-opened tabs across all sessions
 * @param {number} input.originTabs      agent-opened tabs already on this origin
 * @param {string} input.origin
 * @returns {{ok: true} | {ok: false, limit: string, current: number, max: number, origin?: string, message: string}}
 */
export function checkBrowserTabQuotasV1(input) {
	const { quotas, agentIndex, agents, ownTabs, globalTabs, originTabs, origin } = input;
	// The identifier stays in the message so a log line names the limit even without
	// the structured fields.
	const refuse = (limit, current, max, message) => ({ ok: false, limit, current, max, ...(limit === "tabsPerOrigin" ? { origin } : {}), message: `${message} [${limit}]` });
	// The first `maxAgents` sessions keep their slot; a later one cannot open tabs.
	if (agentIndex >= quotas.maxAgents) {
		return refuse("agents", agents, quotas.maxAgents, `同时使用浏览器的 agent 已达上限 ${quotas.maxAgents} 个（当前 ${agents} 个）；请先让其他 agent 结束会话，或 close 旧 tab 后重试`);
	}
	if (ownTabs >= quotas.maxTabsPerAgent) {
		return refuse("tabsPerAgent", ownTabs, quotas.maxTabsPerAgent, `每个 agent 最多 ${quotas.maxTabsPerAgent} 个 tab（当前 ${ownTabs} 个）；请先 close 旧 tab 再打开新的`);
	}
	if (globalTabs >= quotas.maxTabs) {
		return refuse("tabs", globalTabs, quotas.maxTabs, `浏览器 agent tab 总数已达上限 ${quotas.maxTabs} 个（当前 ${globalTabs} 个）；请先 close 旧 tab 再打开新的`);
	}
	if (originTabs >= quotas.maxTabsPerOrigin) {
		return refuse("tabsPerOrigin", originTabs, quotas.maxTabsPerOrigin, `同一 origin 最多 ${quotas.maxTabsPerOrigin} 个 tab（当前 ${originTabs} 个，${origin}）；请先 close 旧 tab 再打开新的`);
	}
	return { ok: true };
}
