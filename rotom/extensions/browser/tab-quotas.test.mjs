import assert from "node:assert/strict";
import test from "node:test";
import {
	BROWSER_TAB_QUOTA_ENV_V1,
	DEFAULT_BROWSER_TAB_QUOTAS_V1,
	browserTabQuotasFromEnvV1,
	checkBrowserTabQuotasV1,
	sanitizeBrowserTabQuotasV1,
} from "./chrome-extension/tab-quotas.js";

const defaults = () => ({ ...DEFAULT_BROWSER_TAB_QUOTAS_V1 });
const counts = (overrides = {}) => ({ agentIndex: 0, agents: 1, ownTabs: 0, globalTabs: 0, originTabs: 0, origin: "https://example.test", ...overrides });

test("配额：默认值就是需求里的四个上限", () => {
	assert.deepEqual(defaults(), { maxAgents: 8, maxTabsPerAgent: 4, maxTabs: 24, maxTabsPerOrigin: 2 });
});

test("配额：每个上限都能拒绝，并写清上限、当前数量与建议动作", () => {
	const quotas = defaults();
	for (const [limit, input, current, max] of [
		["agents", counts({ agentIndex: 8, agents: 9 }), 9, 8],
		["tabsPerAgent", counts({ ownTabs: 4 }), 4, 4],
		["tabs", counts({ globalTabs: 24 }), 24, 24],
		["tabsPerOrigin", counts({ originTabs: 2 }), 2, 2],
	]) {
		const decision = checkBrowserTabQuotasV1({ quotas, ...input });
		assert.equal(decision.ok, false, `${limit} 必须被拒绝`);
		assert.equal(decision.limit, limit);
		assert.equal(decision.current, current);
		assert.equal(decision.max, max);
		assert.match(decision.message, /close 旧 tab|结束会话/u);
		assert.match(decision.message, new RegExp(`\\b${limit}\\b|上限`, "u"));
	}
	// Under every limit is allowed: the boundary is "reached", not "exceeded by one".
	assert.deepEqual(checkBrowserTabQuotasV1({ quotas, ...counts({ agentIndex: 7, agents: 8, ownTabs: 3, globalTabs: 23, originTabs: 1 }) }), { ok: true });
});

test("配额：权限只按 agent 自己开的 tab 计数，origin 判定带出来源", () => {
	const quotas = { ...defaults(), maxTabsPerOrigin: 1 };
	const decision = checkBrowserTabQuotasV1({ quotas, ...counts({ originTabs: 1, origin: "https://two.test" }) });
	assert.equal(decision.ok, false);
	assert.equal(decision.origin, "https://two.test");
	assert.match(decision.message, /two\.test/u);
	// A non-origin limit does not pretend to know the origin.
	const agentLimit = checkBrowserTabQuotasV1({ quotas, ...counts({ ownTabs: 4 }) });
	assert.equal(agentLimit.origin, undefined);
});

test("配额：环境变量覆盖每一项", () => {
	const env = {
		[BROWSER_TAB_QUOTA_ENV_V1.maxAgents]: "2",
		[BROWSER_TAB_QUOTA_ENV_V1.maxTabsPerAgent]: "3",
		[BROWSER_TAB_QUOTA_ENV_V1.maxTabs]: "5",
		[BROWSER_TAB_QUOTA_ENV_V1.maxTabsPerOrigin]: "1",
	};
	assert.deepEqual(browserTabQuotasFromEnvV1(env), { maxAgents: 2, maxTabsPerAgent: 3, maxTabs: 5, maxTabsPerOrigin: 1 });
	assert.deepEqual(browserTabQuotasFromEnvV1({}), defaults(), "没有环境变量时用默认值");
	assert.deepEqual(browserTabQuotasFromEnvV1({ [BROWSER_TAB_QUOTA_ENV_V1.maxTabs]: "" }), defaults(), "空串按未设置处理");
	// Overrides reach the decision, not just the parsing.
	assert.equal(checkBrowserTabQuotasV1({ quotas: browserTabQuotasFromEnvV1(env), ...counts({ ownTabs: 3 }) }).limit, "tabsPerAgent");
	assert.equal(checkBrowserTabQuotasV1({ quotas: browserTabQuotasFromEnvV1({ [BROWSER_TAB_QUOTA_ENV_V1.maxAgents]: "1" }), ...counts({ agentIndex: 1, agents: 2 }) }).limit, "agents");
	// 0 is a real value: it forbids that dimension.
	assert.equal(checkBrowserTabQuotasV1({ quotas: browserTabQuotasFromEnvV1({ [BROWSER_TAB_QUOTA_ENV_V1.maxTabsPerOrigin]: "0" }), ...counts({}) }).limit, "tabsPerOrigin");
});

test("配额：非法环境变量报错而不是静默回退", () => {
	for (const raw of ["abc", "-1", "1.5", "1001", "0x10"]) {
		assert.throws(() => browserTabQuotasFromEnvV1({ [BROWSER_TAB_QUOTA_ENV_V1.maxTabs]: raw }), /ROTOM_BROWSER_MAX_TABS/u, raw);
	}
});

test("配额：来自客户端 hello 的值必须先过校验", () => {
	assert.deepEqual(sanitizeBrowserTabQuotasV1(undefined), defaults());
	assert.deepEqual(sanitizeBrowserTabQuotasV1({ maxTabs: 6 }), { ...defaults(), maxTabs: 6 });
	for (const value of [null, [], "8", { maxTabs: "6" }, { maxTabs: -1 }, { maxTabs: 1.5 }, { maxTabs: 10_000 }, { maxAgents: Number.NaN }]) {
		assert.equal(sanitizeBrowserTabQuotasV1(value), undefined, JSON.stringify(value));
	}
});
