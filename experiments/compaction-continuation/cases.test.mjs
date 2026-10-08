import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "../../packages/rotom-pi/packages/ai/dist/index.js";
import { CASES, historyFor, createFixture } from "./cases.mjs";
import { admit } from "./live.mjs";

for (const c of CASES) {
	test(`${c.id}: completion is judged by state, not summary/final wording`, async () => {
		const bad = createFixture(c, Type);
		if (c.id !== "resolved-update-control") {
			await bad.tool.execute("finish", { action: "finish" });
			assert.equal(bad.grade().pass, false);
		} else {
			await bad.tool.execute("commit", { action: "commit" });
			await bad.tool.execute("finish", { action: "finish" });
			assert.equal(bad.grade().pass, false);
		}
		const good = createFixture(c, Type);
		if (c.id === "unknown-write") await good.tool.execute("status", { action: "receipt_status" });
		else {
			if (!good.state.correct) await good.tool.execute("edit", { action: "edit", change: "clamp-negative" });
			if (good.state.verified !== good.state.revision) await good.tool.execute("test", { action: "check", suite: "unit" });
		}
		await good.tool.execute("finish", { action: "finish" });
		assert.equal(good.grade().pass, true);
		assert(historyFor(c).some((m) => m.role === "toolResult"));
	});
}

test("unknown write replay and stale test evidence cannot pass", async () => {
	const receipt = createFixture(CASES.find((x) => x.id === "unknown-write"), Type);
	await receipt.tool.execute("duplicate", { action: "create_receipt" });
	await receipt.tool.execute("status", { action: "receipt_status" });
	await receipt.tool.execute("finish", { action: "finish" });
	assert.equal(receipt.grade().duplicateReceipts, 1);
	assert.equal(receipt.grade().pass, false);
	const code = createFixture(CASES.find((x) => x.id === "resolved-update-control"), Type);
	await code.tool.execute("edit", { action: "edit", change: "clamp-negative" });
	await code.tool.execute("finish", { action: "finish" });
	assert.equal(code.grade().currentStateVerified, false);
});

test("admission enforces chain, total and time limits before dispatch", () => {
	const make = () => ({ deadline: 100, requests: [] });
	const report = make();
	const chain = { case: "unit", repetition: 1, arm: "baseline", phase: "summary", requests: 0 };
	for (let i = 0; i < 6; i++) admit(report, chain, 0);
	assert.throws(() => admit(report, chain, 0), /admission limit/);
	assert.equal(report.requests.length, 6);
	const all = make();
	for (let i = 0; i < 120; i++) admit(all, { ...chain, requests: 0 }, 0);
	assert.throws(() => admit(all, { ...chain, requests: 0 }, 0), /admission limit/);
	assert.throws(() => admit(make(), { ...chain, requests: 0 }, 100), /admission limit/);
	const carried = { ...make(), priorRequests: 119 };
	admit(carried, { ...chain, requests: 0 }, 0);
	assert.throws(() => admit(carried, { ...chain, requests: 0 }, 0), /admission limit/);
});
