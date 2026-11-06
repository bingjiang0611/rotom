// Tab quotas (T10): the service worker counts and refuses, it never queues.
//
// Each step boots its own tool instance with its own ROTOM_BROWSER_MAX_* values, so the
// assertion covers the whole chain: environment → hello → service worker counts →
// refusal before Chrome creates a tab.

import assert from "node:assert/strict";
import { loadBrowserTools } from "../browser-tools.mjs";

export const description = "tab 配额：per-agent / per-origin / 全局 / agent 数上限，超限直接拒绝";

const ENV_KEYS = ["ROTOM_BROWSER_MAX_AGENTS", "ROTOM_BROWSER_MAX_TABS_PER_AGENT", "ROTOM_BROWSER_MAX_TABS", "ROTOM_BROWSER_MAX_TABS_PER_ORIGIN", "ROTOM_BROWSER_LEASE"];

export async function run({ harness, fixtures, recorder }) {
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	// Quotas apply to the main agent too, and the lease suite owns the leased path.
	const setEnv = (values) => {
		for (const key of ENV_KEYS) delete process.env[key];
		Object.assign(process.env, values);
	};
	const boot = async (values) => {
		setEnv(values);
		return loadBrowserTools({ socketPath: harness.socketPath });
	};
	const open = (tools, name, path = "/baseline") => tools.inspect({ operation: "open", tabName: name, url: fixtures.url(path), limit: 2 });
	const closeAll = async (tools) => {
		await tools.inspect({ operation: "close", all: true }).catch(() => undefined);
		await tools.shutdown();
	};

	try {
		await recorder.check("每个 agent 的 tab 数上限：第三个被拒绝，close 后可以再开", async () => {
			const tools = await boot({ ROTOM_BROWSER_MAX_TABS_PER_AGENT: "2" });
			try {
				await open(tools, "q1");
				await open(tools, "q2");
				await assert.rejects(open(tools, "q3"), (error) => {
					assert.match(error.message, /每个 agent 最多 2 个 tab（当前 2 个）/u);
					assert.match(error.message, /\[tabsPerAgent\]/u);
					assert.match(error.message, /close 旧 tab/u);
					return true;
				});
				await tools.inspect({ operation: "close", tabName: "q1" });
				// Released immediately, and nothing was queued while it was refused.
				assert.equal((await open(tools, "q3")).details.kind, "observation");
			} finally { await closeAll(tools); }
		});

		await recorder.check("同一 origin 的 tab 数上限", async () => {
			const tools = await boot({ ROTOM_BROWSER_MAX_TABS_PER_ORIGIN: "1" });
			try {
				await open(tools, "o1");
				await assert.rejects(open(tools, "o2"), /同一 origin 最多 1 个 tab（当前 1 个，http:\/\/127\.0\.0\.1:\d+）[\s\S]*\[tabsPerOrigin\]/u);
			} finally { await closeAll(tools); }
		});

		await recorder.check("全局 tab 总数上限跨 agent 计数", async () => {
			const first = await boot({ ROTOM_BROWSER_MAX_TABS: "2" });
			const second = await boot({ ROTOM_BROWSER_MAX_TABS: "2" });
			try {
				await open(first, "g1");
				await open(first, "g2");
				await assert.rejects(open(second, "g3"), /浏览器 agent tab 总数已达上限 2 个（当前 2 个）[\s\S]*\[tabs\]/u);
			} finally { await closeAll(second); await closeAll(first); }
		});

		await recorder.check("同时连接的 agent 数上限：先连上的保留额度，后来的只读仍可用", async () => {
			const first = await boot({ ROTOM_BROWSER_MAX_AGENTS: "1" });
			const second = await boot({ ROTOM_BROWSER_MAX_AGENTS: "1" });
			try {
				assert.equal((await open(first, "a1")).details.kind, "observation");
				await assert.rejects(open(second, "a2"), /同时使用浏览器的 agent 已达上限 1 个（当前 2 个）[\s\S]*\[agents\]/u);
				assert.equal((await second.inspect({ operation: "tabs" })).details.kind, "tabs", "只读不受 agent 上限影响");
			} finally { await closeAll(second); await closeAll(first); }
		});

		await recorder.check("非法配额环境变量直接报错，不静默回退", async () => {
			const tools = await boot({ ROTOM_BROWSER_MAX_TABS: "abc" });
			try {
				await assert.rejects(open(tools, "bad"), /ROTOM_BROWSER_MAX_TABS 必须是 0–1000 的整数/u);
			} finally { await tools.shutdown(); }
		});
	} finally {
		setEnv({});
		for (const key of ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}
