// Dashboard routes for replay points: auth, method, content type, origin, and the
// six endpoints. Synthetic sessions only; the runner is faked so no product
// runtime or model is needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
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
	assert.deepEqual(await fetch(url("/api/eval/replay/cases"), { headers }).then((response) => response.json()), { cases: [] });
	const created = await fetch(url("/api/eval/replay/case"), { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "checks-before-claiming" } }) });
	assert.equal(created.status, 200);
	const point = await created.json();
	const listed = await fetch(url("/api/eval/replay/cases"), { headers }).then((response) => response.json());
	assert.equal(listed.cases.length, 1);
	assert.equal(listed.cases[0].key, point.key);
	const started = await fetch(url("/api/eval/replay/run"), { method: "POST", headers, body: JSON.stringify({ cases: [point.key], model: "faux/faux-1", repeats: 1 }) });
	assert.equal(started.status, 202);
	const job = await started.json();
	assert.equal(job.total, 1);
	assert.deepEqual(await fetch(url("/api/eval/replay/cancel"), { method: "POST", headers, body: JSON.stringify({ runId: "missing" }) }).then((response) => response.json()), { cancelled: false, status: "unknown" });
	assert.equal((await fetch(url("/api/eval/replay/run"), { method: "POST", headers, body: JSON.stringify({ cases: [], model: "faux/faux-1" }) })).status, 400);
	const deleted = await fetch(url("/api/eval/replay/case/delete"), { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, cutEntryId: first }) });
	assert.deepEqual(await deleted.json(), { deleted: true });
	assert.deepEqual(await fetch(url("/api/eval/replay/cases"), { headers }).then((response) => response.json()), { cases: [] });
});

test("replay routes are absent when the service is disabled", async (t) => {
	const home = await space();
	const dashboard = await startTraceDashboard({ root: home.sessions, token: "replay-token", evalDirectory: home.directory, replay: false });
	t.after(() => dashboard.close());
	const headers = { authorization: "Bearer replay-token", "content-type": "application/json" };
	assert.equal((await fetch(`${dashboard.baseUrl}/api/eval/replay/cases`, { headers })).status, 409);
	assert.equal((await fetch(`${dashboard.baseUrl}/api/eval/replay/run`, { method: "POST", headers, body: JSON.stringify({ cases: ["a"], model: "faux/faux-1" }) })).status, 409);
});
