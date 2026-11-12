/**
 * The probe helpers that moved out of the L2 script (2026-11-07, B0 window).
 *
 * The B0 run aborted with `alive is not defined`: `alive` was left behind when the probe
 * helpers moved into `scripts/lib/l2-probe.mjs`, and because the identifier is only
 * evaluated during a real run, a green suite and a green dry run both missed it. These
 * tests cover the factory that now owns it, and the probe's recording contract.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createAlive, createProbe } from "../scripts/lib/l2-probe.mjs";

test("alive is true only when the helper answers with the expected protocol", async () => {
	const answers = (value: unknown) => ({ diagnosticsCommand: async () => value });
	assert.equal(await createAlive({ helper: answers({ protocolVersion: 9 }), expectedProtocol: 9 })(), true);
	// A helper from another build is not "alive" for this run's purposes.
	assert.equal(await createAlive({ helper: answers({ protocolVersion: 8 }), expectedProtocol: 9 })(), false);
});

test("a helper that throws or times out is not alive", async () => {
	const failing = { diagnosticsCommand: async () => { throw new Error("socket closed"); } };
	assert.equal(await createAlive({ helper: failing, expectedProtocol: 9 })(), false);
});

test("the probe records the delivery and the sampled surroundings", async () => {
	const rows: unknown[] = [];
	let cursor = 10;
	const backend = {
		getFrontmost: async () => ({ appName: "Scry", pid: 42 }),
		act: async () => ({ outcome: "unknown", performed: { delivery: "l2" } }),
	};
	const probe = createProbe({ backend, record: (...row: unknown[]) => rows.push(row), cursor: async () => ({ x: cursor++, y: 0 }) });
	const result = await probe("direct L2", { lookId: "look" }, 7, { action: "click", ref: "@e1" });
	assert.equal(result.delivery, "l2");
	assert.equal(result.outcome, "unknown");
	assert.equal(result.cursorMoved, true);
	const [area, action, verdict, note] = rows.at(-1) as [string, string, string, string];
	assert.deepEqual([area, action, verdict], ["direct L2", "click", "inconclusive"]);
	assert.match(note, /delivery=l2/);
	assert.match(note, /cursorMoved=true/);
});

test("a helper refusal is recorded, never silently dropped", async () => {
	const rows: unknown[] = [];
	const backend = {
		getFrontmost: async () => ({ appName: "Scry", pid: 42 }),
		act: async () => { throw new Error("ax_only cannot deliver typeText"); },
	};
	const probe = createProbe({ backend, record: (...row: unknown[]) => rows.push(row), cursor: async () => ({ x: 1, y: 1 }) });
	const result = await probe("fixture", { lookId: "look" }, 7, { action: "typeText", ref: "@e1" });
	assert.equal(result.outcome, "error");
	assert.match(String((rows.at(-1) as string[])[3]), /ax_only cannot deliver typeText/);
});
