// M1 end-to-end (T11): four agents, one root session, real form work at the same time.
//
// Each agent drives the real tools over the harness Chrome: open its own tab, read it,
// type, select, click and read back its own values, five rounds. The assertions are the
// ones a human would check: nobody reads anyone else's values, the operator's tab stays
// the active one, ownership stays per agent, and the latency distribution is recorded
// instead of asserted, because a shared browser is not a benchmark.

import assert from "node:assert/strict";
import { loadBrowserTools } from "../browser-tools.mjs";

export const description = "4 个 agent 同时完成各自的表单流程，5 轮无串台，用户 tab 保持前台";

/** Chrome starts on this page, so the suite has a real operator tab to check. */
export const startUrlPage = "/user";

const AGENTS = ["agent-1", "agent-2", "agent-3", "agent-4"];
const ROUNDS = 5;

function percentile(values, fraction) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return Math.round(sorted[index]);
}

async function timed(samples, name, run) {
	const startedAt = performance.now();
	try { return await run(); }
	finally {
		const bucket = samples.get(name) ?? [];
		bucket.push(performance.now() - startedAt);
		samples.set(name, bucket);
	}
}

export async function run({ harness, fixtures, recorder }) {
	const samples = new Map();
	const saved = Object.fromEntries(["ROTOM_BROWSER_AGENT_ID", "ROTOM_BROWSER_ROOT_SESSION", "ROTOM_BROWSER_LEASE", "ROTOM_BROWSER_MAX_TABS_PER_ORIGIN"].map((key) => [key, process.env[key]]));
	const agents = [];
	try {
		// The product default refuses a third tab on one origin; this suite needs one tab
		// per agent on the fixture origin, so it raises that single limit explicitly.
		for (const agentId of AGENTS) {
			process.env.ROTOM_BROWSER_AGENT_ID = agentId;
			process.env.ROTOM_BROWSER_ROOT_SESSION = "e2e-root";
			delete process.env.ROTOM_BROWSER_LEASE;
			process.env.ROTOM_BROWSER_MAX_TABS_PER_ORIGIN = "8";
			agents.push({ agentId, tools: await loadBrowserTools({ socketPath: harness.socketPath }) });
		}

		const refOf = (observation, role, name) => {
			const node = observation.nodes.find((candidate) => candidate.role === role && (name === undefined || candidate.name.includes(name)));
			assert.ok(node, `${role}/${name ?? "*"} 不在 observation 里：${observation.nodes.slice(0, 8).map((node) => `${node.role}:${node.name}`).join(" | ")}`);
			return node.ref;
		};
		const resultText = (readback) => (readback.nodes ?? []).map((node) => node.name).join(" ");

		for (let round = 1; round <= ROUNDS; round += 1) {
			await recorder.check(`第 ${round} 轮：4 个 agent 并行完成表单`, async () => {
				const tokens = new Map(agents.map(({ agentId }) => [agentId, `${agentId}-r${round}-${Math.random().toString(36).slice(2, 8)}`]));
				const outcomes = await Promise.allSettled(agents.map(async ({ agentId, tools }) => {
					const token = tokens.get(agentId);
					const tabName = `form-${agentId}-${round}`;
					const opened = await timed(samples, "open", () => tools.inspect({ operation: "open", tabName, url: fixtures.url("/form"), limit: 40 }));
					assert.equal(opened.details.kind, "observation", `${agentId} open 必须返回 observation`);
					const observation = opened.details.observation;
					const nameRef = refOf(observation, "textbox", "Agent name");
					const planRef = refOf(observation, "combobox", undefined);
					const submitRef = refOf(observation, "button", "Submit form");
					await timed(samples, "type", () => tools.interact({ operation: "execute", tabName, action: "type", targetRef: nameRef, text: token, expect: "value=nonempty" }));
					await timed(samples, "select", () => tools.interact({ operation: "execute", tabName, action: "select", targetRef: planRef, option: "active" }));
					const clicked = await timed(samples, "click", () => tools.interact({ operation: "execute", tabName, action: "click", targetRef: submitRef }));
					assert.equal(clicked.details.acknowledged, true, `${agentId} click 必须被接受`);
					const readback = await timed(samples, "readback", () => tools.inspect({ operation: "snapshot_visible", tabName, limit: 40 }));
					return { agentId, tabName, token, text: resultText(readback.details.observation), tools };
				}));
				for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;

				// No cross-talk: each agent reads its own value, and nobody else's.
				for (const { agentId, text, token } of outcomes.map((outcome) => outcome.value)) {
					assert.match(text, new RegExp(`name=${token} plan=active`, "u"), `${agentId} 必须读回自己填的值：${text.slice(0, 160)}`);
					for (const [otherId, otherToken] of tokens) {
						if (otherId === agentId) continue;
						assert.equal(text.includes(otherToken), false, `${agentId} 读到了 ${otherId} 的值`);
					}
				}

				// Ownership: each agent's tab list contains only its own tab this round.
				const listings = await Promise.all(agents.map(({ agentId, tools }) => timed(samples, "tabs", () => tools.inspect({ operation: "tabs" })).then((result) => ({ agentId, names: result.details.tabs.map((tab) => tab.name) }))));
				for (const { agentId, names } of listings) {
					assert.deepEqual(names, [`form-${agentId}-${round}`], `${agentId} 的 tab 归属必须只有自己的`);
					for (const otherId of AGENTS) {
						if (otherId === agentId) continue;
						assert.equal(names.some((name) => name.includes(otherId)), false, `${agentId} 看到了 ${otherId} 的 tab`);
					}
				}

				// The operator's tab is still the foreground tab after four agents worked.
				const discovered = await agents[0].tools.inspect({ operation: "discover" });
				const userTab = discovered.details.tabs.find((tab) => new URL(tab.url).pathname === "/user");
				assert.ok(userTab, "用户 tab 仍然可发现");
				assert.equal(userTab.browserActive, true, "用户 tab 必须始终是 active，agent 的 tab 只能开在后台");

				// Each round owns one tab per agent; keeping them would hit the per-origin
				// quota on the next round.
				const outcomesValues = outcomes.map((outcome) => outcome.value);
				const closed = await Promise.allSettled(outcomesValues.map(({ tabName, tools: agentTools }) => timed(samples, "close", () => agentTools.inspect({ operation: "close", tabName }))));
				for (const outcome of closed) if (outcome.status === "rejected") throw outcome.reason;
			});
		}

		await recorder.check("延迟分布可计算（count/p50/p95）", async () => {
			for (const [name, values] of samples) assert.ok(values.length >= ROUNDS, `${name} 的样本太少：${values.length}`);
			const report = Object.fromEntries([...samples].map(([name, values]) => [name, { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }]));
			process.stdout.write(`# parallel-4 延迟（ms，含工具层 + relay + Chrome 往返）：${JSON.stringify(report)}\n`);
		});
	} finally {
		for (const { tools } of agents) {
			await tools.inspect({ operation: "close", all: true }).catch(() => undefined);
			await tools.shutdown();
		}
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}
