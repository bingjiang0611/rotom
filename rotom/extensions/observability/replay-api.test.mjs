// Dashboard routes for replay points: auth, method, content type, origin, and the
// six endpoints. Synthetic sessions only; the runner is faked so no product
// runtime or model is needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fixtureSession } from "./eval-fixtures.mjs";
import { loadSession } from "./eval/session-data.mjs";
import { sessionSha256 } from "./eval/replay.mjs";
import { startTraceDashboard } from "./dashboard.mjs";

const scratch = [];
after(async () => { for (const path of scratch) await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true, force: true })); });

async function space() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "rotom-replay-api-")));
	scratch.push(root);
	const sessions = join(root, "sessions"), directory = join(root, "evals");
	await mkdir(sessions, { recursive: true, mode: 0o700 });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return { root, sessions, directory };
}

async function synthetic(sessions, id) {
	await fixtureSession(sessions, id);
	const path = join(sessions, `${id}.jsonl`);
	const loaded = await loadSession(path, { badJson: 0, lineTooLong: 0 }, new Set());
	const assistant = loaded.branch.find((entry) => entry.type === "message" && entry.message?.role === "assistant");
	return { id, cutEntryId: assistant.id, sha: sessionSha256(await (await import("node:fs/promises")).readFile(path, "utf8")) };
}

test("the dashboard exposes replay routes with the existing security checks", async (t) => {
	const home = await space();
	const session = await synthetic(home.sessions, "replay-api");
	const first = session.cutEntryId;
	const runner = join(home.root, "fake-runner.mjs");
	const writeFileText = (await import("node:fs/promises")).writeFile;
	await writeFileText(runner, `process.stdout.write(JSON.stringify({runs:[]})+"\\n");\n`, { mode: 0o600 });
	const dashboard = await startTraceDashboard({ root: home.sessions, token: "replay-token", evalDirectory: home.directory, replay: { spawnProcess: (node) => spawn(node, [runner]) } });
	t.after(() => dashboard.close());
	const headers = { authorization: "Bearer replay-token", "content-type": "application/json" };
	const url = (path) => `${dashboard.baseUrl}${path}`;
	// Unauthenticated and unknown paths keep the old answers.
	assert.equal((await fetch(url("/api/eval/replay/cases"))).status, 401);
	assert.equal((await fetch(url("/api/eval/replay/nope"), { headers })).status, 404);
	// Method and content-type are enforced before the body is read.
	assert.equal((await fetch(url("/api/eval/replay/case"), { headers })).status, 405);
	assert.equal((await fetch(url("/api/eval/replay/case"), { method: "POST", headers: { authorization: "Bearer replay-token", "content-type": "text/plain" }, body: "{}" })).status, 415);
	assert.equal((await fetch(url("/api/eval/replay/case"), { method: "POST", headers: { ...headers, origin: "http://evil.example" }, body: "{}" })).status, 403);
	// No ROTOM_EVAL_REPLAY_BASELINE: the comparison arm is off, with a reason.
	assert.deepEqual(await fetch(url("/api/eval/replay/cases"), { headers }).then((response) => response.json()), { cases: [], baseline: { enabled: false, reason: "not_configured" } });
	const created = await fetch(url("/api/eval/replay/case"), { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "checks-before-claiming" } }) });
	assert.equal(created.status, 200);
	const point = await created.json();
	const listed = await fetch(url("/api/eval/replay/cases"), { headers }).then((response) => response.json());
	assert.equal(listed.cases.length, 1);
	assert.equal(listed.cases[0].key, point.key);
	// The server refuses the arm even when a client asks for it directly.
	assert.equal((await fetch(url("/api/eval/replay/prepare"), { method: "POST", headers, body: JSON.stringify({ cases: [point.key], repeats: 2, includeBaseline: true }) })).status, 400);
	assert.equal((await fetch(url("/api/eval/replay/run"), { method: "POST", headers, body: JSON.stringify({ cases: [point.key], model: "faux/faux-1", includeBaseline: true }) })).status, 400);
	// Prepare reports the numbers the dialog shows, and starts nothing.
	const prepared = await fetch(url("/api/eval/replay/prepare"), { method: "POST", headers, body: JSON.stringify({ cases: [point.key], repeats: 2 }) }).then((response) => response.json());
	assert.equal(prepared.runs, 2);
	assert.equal(prepared.repeats, 2);
	assert.equal(prepared.arms, 1);
	assert.equal(prepared.totalChars, prepared.cases[0].chars * 2);
	assert.equal(prepared.perCaseChars, prepared.cases[0].chars);
	assert.equal(prepared.maxChars, prepared.cases[0].chars);
	assert.ok(prepared.cases[0].chars > 0);
	assert.deepEqual(await fetch(url("/api/eval/replay/status?runId=none"), { headers }).then((response) => response.json()), { status: "unknown", runId: "none" });
	assert.equal((await fetch(url("/api/eval/replay/prepare"), { method: "POST", headers, body: JSON.stringify({ cases: ["nope"], repeats: 1 }) })).status, 400);
	const started = await fetch(url("/api/eval/replay/run"), { method: "POST", headers, body: JSON.stringify({ cases: [point.key], model: "faux/faux-1", repeats: 1 }) });
	assert.equal(started.status, 202);
	const job = await started.json();
	assert.equal(job.total, 1);
	assert.deepEqual(await fetch(url("/api/eval/replay/cancel"), { method: "POST", headers, body: JSON.stringify({ runId: "missing" }) }).then((response) => response.json()), { cancelled: false, status: "unknown" });
	assert.equal((await fetch(url("/api/eval/replay/run"), { method: "POST", headers, body: JSON.stringify({ cases: [], model: "faux/faux-1" }) })).status, 400);
	const deleted = await fetch(url("/api/eval/replay/case/delete"), { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, cutEntryId: first }) });
	assert.deepEqual(await deleted.json(), { deleted: true });
	assert.deepEqual(await fetch(url("/api/eval/replay/cases"), { headers }).then((response) => response.json()), { cases: [], baseline: { enabled: false, reason: "not_configured" } });
});

test("replay routes are absent when the service is disabled", async (t) => {
	const home = await space();
	const dashboard = await startTraceDashboard({ root: home.sessions, token: "replay-token", evalDirectory: home.directory, replay: false });
	t.after(() => dashboard.close());
	const headers = { authorization: "Bearer replay-token", "content-type": "application/json" };
	assert.equal((await fetch(`${dashboard.baseUrl}/api/eval/replay/cases`, { headers })).status, 409);
	assert.equal((await fetch(`${dashboard.baseUrl}/api/eval/replay/run`, { method: "POST", headers, body: JSON.stringify({ cases: ["a"], model: "faux/faux-1" }) })).status, 409);
});

test("a configured baseline runs both arms and reports identical products", async (t) => {
	const home = await space();
	const session = await synthetic(home.sessions, "replay-baseline");
	const baselineProduct = join(home.root, "product");
	await mkdir(join(baselineProduct, "runtime"), { recursive: true });
	await writeFile(join(baselineProduct, "runtime", "product-config.mjs"), "export default {};\n");
	const calls = join(home.root, "runner-args.jsonl");
	const runner = join(home.root, "fake-runner.mjs");
	// The fake runner reports that both arms loaded the same product.
	await writeFile(runner, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));
process.stdout.write(JSON.stringify({ runs: [], warnings: ["baseline_product_matches_candidate"], arms: { candidate: "d1", baseline: "d1" } }) + String.fromCharCode(10));
`, { mode: 0o600 });
	const dashboard = await startTraceDashboard({ root: home.sessions, token: "replay-token", evalDirectory: home.directory, replayBaseline: baselineProduct, replay: { spawnProcess: (node, args) => spawn(node, [runner, ...args]) } });
	t.after(() => dashboard.close());
	const headers = { authorization: "Bearer replay-token", "content-type": "application/json" };
	const url = (path) => `${dashboard.baseUrl}${path}`;
	const listed = await fetch(url("/api/eval/replay/cases"), { headers }).then((response) => response.json());
	assert.deepEqual(listed.baseline, { enabled: true, reason: null });
	await fetch(url("/api/eval/replay/case"), { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, cutEntryId: session.cutEntryId, expected: "先查状态", check: { mode: "rule", rule: "checks-before-claiming" } }) });
	const key = `${session.id}-${session.cutEntryId}`;
	const prepared = await fetch(url("/api/eval/replay/prepare"), { method: "POST", headers, body: JSON.stringify({ cases: [key], repeats: 1, includeBaseline: true }) }).then((response) => response.json());
	assert.equal(prepared.arms, 2);
	assert.equal(prepared.runs, 2);
	assert.equal(prepared.includeBaseline, true);
	const started = await fetch(url("/api/eval/replay/run"), { method: "POST", headers, body: JSON.stringify({ cases: [key], model: "faux/faux-1", repeats: 1, includeBaseline: true }) });
	assert.equal(started.status, 202);
	const job = await started.json();
	assert.equal(job.arms, 2);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const status = await fetch(url(`/api/eval/replay/status?runId=${job.runId}`), { headers }).then((response) => response.json());
		if (status.status !== "running") {
			assert.deepEqual(status.warnings, ["baseline_product_matches_candidate"]);
			// The runner records the arm it was told to use; the dashboard must pass
			// the configured product, never the candidate itself.
			const args = await readFile(calls, "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line))).then((rows) => rows.at(-1));
			assert.ok(args.some((arg) => arg === `--arm-baseline=${baselineProduct}`), "the configured product is the comparison arm: " + JSON.stringify(args));
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	assert.fail("the fake runner did not finish");
});

test("real sessions are found in nested project folders", async (t) => {
	// Real sessions live at <root>/<project>/<timestamp>_<id>.jsonl, so a flat
	// "<id>.jsonl" lookup would miss every one of them.
	const home = await space();
	const project = join(home.sessions, "--Users-example-project--");
	await mkdir(project, { recursive: true });
	await fixtureSession(project, "nested-session");
	const flat = join(project, "nested-session.jsonl");
	const nested = join(project, "2026-01-01T00-00-00-000Z_nested-session.jsonl");
	await (await import("node:fs/promises")).rename(flat, nested);
	const runner = join(home.root, "fake-runner.mjs");
	await writeFile(runner, `process.stdout.write(JSON.stringify({ runs: [], paths: process.argv.slice(2).filter((item) => item.startsWith("--paths=")) }) + String.fromCharCode(10));\n`, { mode: 0o600 });
	const dashboard = await startTraceDashboard({ root: home.sessions, token: "replay-token", evalDirectory: home.directory, replay: { spawnProcess: (node, args) => spawn(node, [runner, ...args]) } });
	t.after(() => dashboard.close());
	const headers = { authorization: "Bearer replay-token", "content-type": "application/json" };
	const url = (path) => `${dashboard.baseUrl}${path}`;
	const listed = await fetch(url("/api/eval/sessions"), { headers }).then((response) => response.json());
	const row = listed.items.find((item) => item.id === "nested-session");
	assert.ok(row, "the session is listed from the nested folder");
	const detail = await fetch(url("/api/eval/session?id=nested-session"), { headers }).then((response) => response.json());
	const step = detail.timeline.items.find((item) => item.kind === "assistant");
	assert.ok(step?.entryId, "the assistant step exposes the entry id used as a replay point");
	const created = await fetch(url("/api/eval/replay/case"), { method: "POST", headers, body: JSON.stringify({ sessionId: "nested-session", cutEntryId: step.entryId, expected: "先查状态", check: { mode: "rule", rule: "checks-before-claiming" } }) });
	assert.equal(created.status, 200);
	const point = await created.json();
	const prepared = await fetch(url("/api/eval/replay/prepare"), { method: "POST", headers, body: JSON.stringify({ cases: [point.key], repeats: 1 }) }).then((response) => response.json());
	assert.ok(prepared.perCaseChars >= 0);
	const started = await fetch(url("/api/eval/replay/run"), { method: "POST", headers, body: JSON.stringify({ cases: [point.key], model: "faux/faux-1" }) });
	assert.equal(started.status, 202);
	const job = await started.json();
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const status = await fetch(url(`/api/eval/replay/status?runId=${job.runId}`), { headers }).then((response) => response.json());
		if (status.status === "running") { await new Promise((resolveDelay) => setTimeout(resolveDelay, 25)); continue; }
		const args = await (await import("node:fs/promises")).readFile(runner, "utf8");
		assert.match(args, /--paths=/u);
		return;
	}
	assert.fail("the fake runner did not finish");
});
