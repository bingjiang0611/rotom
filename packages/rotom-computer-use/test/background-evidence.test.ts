import assert from "node:assert/strict";
import test from "node:test";

import { createBackgroundEvidence } from "../scripts/lib/background-evidence.mjs";

function harness(frontmost: Array<{ pid: number; appName: string; bundleId?: string }>, agentCounts = [4, 4]) {
	const rows: Array<{ area: string; action: string; result: string; note: string }> = [];
	let activityIndex = 0;
	let currentFrontmost = frontmost[0] ?? { pid: 10, appName: "Editor" };
	const backend = {
		getFrontmost: async () => {
			currentFrontmost = frontmost.shift() ?? currentFrontmost;
			return currentFrontmost;
		},
		act: async () => ({ outcome: "worked" }),
		manageApps: async () => ({ launched: true, alreadyRunning: false, pid: 51 }),
	};
	const helper = {
		command: async (command: string) => command === "userActivity"
			? { agentHidEventCount: agentCounts[Math.min(activityIndex++, agentCounts.length - 1)] }
			: { outcome: "worked" },
	};
	const evidence = createBackgroundEvidence({
		backend,
		helper,
		record: (area: string, action: string, result: string, note: string) => rows.push({ area, action, result, note }),
	});
	evidence.setHelperPid(99, ["background-delivery-no-cursor-warp"]);
	return { evidence, rows };
}

test("operator app switches are recorded but do not fail focus safety", async () => {
	const { evidence, rows } = harness([
		{ pid: 10, appName: "Editor" },
		{ pid: 11, appName: "Browser" },
	]);
	await evidence.start();
	await evidence.backend.act({});
	await evidence.finish();
	assert.equal(rows.find((row) => row.action === "focus taken")?.result, "pass");
	assert.match(rows.find((row) => row.action === "focus taken")?.note ?? "", /user switches=1/);
	assert.equal(rows.find((row) => row.action === "agent HID events")?.result, "pass");
	assert.equal(rows.find((row) => row.action === "cursor warped")?.result, "pass");
});

test("a launch that makes its own process frontmost fails focus safety", async () => {
	const { evidence, rows } = harness([
		{ pid: 10, appName: "Editor" },
		{ pid: 51, appName: "Fixture", bundleId: "com.example.fixture" },
	]);
	await evidence.start();
	await evidence.backend.manageApps({ mode: "launch", bundleId: "com.example.fixture", activates: false });
	await evidence.finish();
	assert.equal(rows.find((row) => row.action === "focus taken")?.result, "fail");
});

test("agent-marked HID growth fails a background step", async () => {
	const { evidence, rows } = harness([], [7, 8]);
	await evidence.start();
	await evidence.finish();
	const row = rows.find((candidate) => candidate.action === "agent HID events");
	assert.equal(row?.result, "fail");
	assert.match(row?.note ?? "", /\+1/);
});

test("missing helper identity makes focus evidence fail", async () => {
	const { evidence, rows } = harness([]);
	evidence.setHelperPid(undefined);
	await evidence.start();
	await evidence.finish();
	assert.equal(rows.find((row) => row.action === "focus taken")?.result, "fail");
	assert.match(rows.find((row) => row.action === "focus taken")?.note ?? "", /helper pid unavailable/);
});

test("missing cursor invariant makes cursor evidence fail", async () => {
	const { evidence, rows } = harness([]);
	evidence.setHelperPid(99, []);
	await evidence.start();
	await evidence.finish();
	assert.equal(rows.find((row) => row.action === "cursor warped")?.result, "fail");
});

test("failed frontmost reads make focus evidence fail", async () => {
	const rows: Array<{ area: string; action: string; result: string; note: string }> = [];
	const evidence = createBackgroundEvidence({
		backend: { getFrontmost: async () => { throw new Error("AX unavailable"); }, act: async () => ({ outcome: "worked" }) },
		helper: { command: async () => ({ agentHidEventCount: 0 }) },
		record: (area: string, action: string, result: string, note: string) => rows.push({ area, action, result, note }),
	});
	evidence.setHelperPid(99, ["background-delivery-no-cursor-warp"]);
	await evidence.start();
	await evidence.backend.act({});
	await evidence.finish();
	assert.equal(rows.find((row) => row.action === "focus taken")?.result, "fail");
	assert.match(rows.find((row) => row.action === "focus taken")?.note ?? "", /frontmost read failed/);
});
