import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, readFile, readdir, rm, stat, symlink, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { startTraceDashboard } from "./dashboard.mjs";
import { fixtureSession, ATTACK } from "./eval-fixtures.mjs";
import { ACTIVE_WINDOW_MS, MAX_PREVIEW_CHARS, MAX_RESPONSE_BYTES, preview, sessionState, timelinePage } from "./eval/service.mjs";
import { annotationInput, mergedLabels, readAnnotations, writeAnnotation } from "./eval/annotations.mjs";
import { buildCards, collectLabels, reviewCards } from "../../evals/scripts/session-cards.mjs";
import { Readable, Writable } from "node:stream";

async function workspace(t) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "rotom-eval-test-")));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = join(directory, "sessions"), evalDirectory = join(directory, "private");
	await mkdir(root); return { directory, root, evalDirectory };
}
const annotation = (sessionId = "synthetic-idle", extra = {}) => ({ sessionId, verdict: "fail", note: "合成原因", failSet: true, ...extra });
async function api(t) {
	const paths = await workspace(t);
	await fixtureSession(paths.root);
	await fixtureSession(paths.root, "synthetic-active", { active: true });
	const dashboard = await startTraceDashboard(paths);
	t.after(() => dashboard.close());
	const headers = { authorization: `Bearer ${dashboard.token}`, "content-type": "application/json" };
	const post = (body, changedHeaders = {}, method = "POST") => fetch(dashboard.baseUrl + "/api/eval/annotation", { method, headers: { ...headers, ...changedHeaders }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
	return { ...paths, dashboard, headers, post };
}

test("activity evidence has three states and inclusive five-minute boundary", () => {
	const now = 1_000_000;
	assert.equal(sessionState(undefined, NaN, now), "unknown");
	assert.equal(sessionState(now - ACTIVE_WINDOW_MS, undefined, now), "active");
	assert.equal(sessionState(now - ACTIVE_WINDOW_MS - 1, undefined, now), "idle");
	assert.equal(sessionState(0, now, now), "active");
});
test("timeline marks first error, bounds Unicode previews and validates snapshot cursors", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: ATTACK + "😀".repeat(3000) } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "edit", arguments: { oldText: ATTACK } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "call", isError: true, content: ATTACK } },
		...Array.from({ length: 40 }, () => ({ type: "message", message: { role: "assistant", content: "page" } })),
	];
	const first = timelinePage(branch, new Map(), null, "v1");
	assert.equal(first.firstError, 1); assert.equal(first.items[1].firstError, true);
	assert.equal(first.items[0].content.truncated, true);
	assert.equal(Array.from(first.items[0].content.text).length, MAX_PREVIEW_CHARS);
	assert.equal(first.items[1].result.text, ATTACK);
	assert.ok(Buffer.byteLength(JSON.stringify(first)) < MAX_RESPONSE_BYTES);
	const second = timelinePage(branch, new Map(), first.nextCursor, "v1");
	assert.equal(second.items[0].index, first.items.length);
	assert.throws(() => timelinePage(branch, new Map(), first.nextCursor, "v2"), /session_changed/);
	assert.throws(() => timelinePage(branch, new Map(), "bad", "v1"), /invalid_cursor/);
	assert.equal(preview("😀".repeat(2001)).truncated, true);
});
test("Eval reads require auth/Host and POST rejects invalid headers, origins, IDs and bodies without writes", async (t) => {
	const { dashboard, evalDirectory, headers, post } = await api(t);
	assert.equal((await fetch(dashboard.baseUrl + "/api/eval/sessions")).status, 401);
	assert.equal((await fetch(dashboard.baseUrl + "/api/eval/session?id=synthetic-idle")).status, 401);
	assert.equal((await post(annotation(), { authorization: "Bearer wrong" })).status, 401);
	const wrongHost = await new Promise((accept, reject) => {
		const request = httpRequest(dashboard.baseUrl + "/api/eval/annotation", { method: "POST", headers: { ...headers, host: "evil.example" } }, (response) => { response.resume(); accept(response.statusCode); });
		request.on("error", reject); request.end(JSON.stringify(annotation()));
	});
	assert.equal(wrongHost, 421);
	assert.equal((await post(annotation(), { "content-type": "text/plain" })).status, 415);
	assert.equal((await post(annotation(), { origin: "https://evil.example" })).status, 403);
	assert.equal((await post(annotation(), { origin: "null" })).status, 403);
	assert.equal((await post(annotation("absent"))).status, 404);
	for (const id of ["../escape", "/tmp/file", "a/b", "a\\b"]) assert.equal((await post(annotation(id))).status, 400);
	assert.equal((await post(annotation(undefined, { verdict: "maybe" }))).status, 400);
	assert.equal((await post(annotation(undefined, { verdict: "pass" }))).status, 400);
	assert.equal((await post(annotation(undefined, { note: 1 }))).status, 400);
	assert.equal((await post(annotation(undefined, { failSet: "true" }))).status, 400);
	assert.equal((await post(annotation(undefined, { note: "x".repeat(5000) }))).status, 413);
	assert.equal((await post(annotation("synthetic-active"))).status, 409);
	assert.equal((await fetch(dashboard.baseUrl + "/api/eval/annotation", { headers })).headers.get("allow"), "POST");
	assert.equal((await fetch(dashboard.baseUrl + "/api/eval/sessions", { method: "POST", headers })).headers.get("allow"), "GET");
	await assert.rejects(stat(join(evalDirectory, "annotations")), { code: "ENOENT" });
	const list = await fetch(dashboard.baseUrl + "/api/eval/sessions", { headers });
	assert.equal(list.headers.get("access-control-allow-origin"), null);
	assert.equal(list.headers.get("cache-control"), "no-store");
	const data = await list.json(); assert.equal(data.total, 2); assert.deepEqual(data.states, { active: 1, idle: 1, unknown: 0 });
	assert.ok(data.items.find((row) => row.id === "synthetic-idle").request.includes("<script>"));
	const detail = await fetch(dashboard.baseUrl + "/api/eval/session?id=synthetic-idle", { headers });
	assert.equal(detail.status, 200); assert.ok((await detail.json()).timeline.items.some((row) => row.firstError));
});
test("catalog and detail use the same legacy/blank/malformed header reader", async (t) => {
	const { root, dashboard, headers } = await api(t);
	const path = await fixtureSession(root, "synthetic-header");
	const content = await readFile(path, "utf8");
	await writeFile(path, "\nmalformed\nfalse\n" + content);
	const listing = await (await fetch(dashboard.baseUrl + "/api/eval/sessions", { headers })).json();
	assert.ok(listing.items.some((row) => row.id === "synthetic-header" && !row.unavailable));
	assert.equal((await fetch(dashboard.baseUrl + "/api/eval/session?id=synthetic-header", { headers })).status, 200);
});

test("chunked body limit rejects without annotation", async (t) => {
	const { dashboard, evalDirectory, headers } = await api(t);
	const status = await new Promise((accept, reject) => {
		const request = httpRequest(dashboard.baseUrl + "/api/eval/annotation", { method: "POST", headers: { ...headers, "transfer-encoding": "chunked" } }, (response) => { response.resume(); accept(response.statusCode); });
		request.on("error", reject); request.write('{"note":"' + "x".repeat(5000)); request.end('"}');
	});
	assert.equal(status, 413);
	await assert.rejects(stat(join(evalDirectory, "annotations")), { code: "ENOENT" });
});
test("valid POST persists atomically at 0600, truncates note, survives refresh and rejects newly active trace", async (t) => {
	const { root, dashboard, evalDirectory, headers, post } = await api(t);
	const response = await post(annotation(undefined, { note: "字".repeat(600) }), { origin: dashboard.baseUrl });
	assert.equal(response.status, 200);
	const path = join(evalDirectory, "annotations", "synthetic-idle.json");
	const saved = JSON.parse(await readFile(path, "utf8"));
	assert.equal(saved.note.length, 500); assert.equal(saved.schema, "rotom-eval-annotation/v1"); assert.equal(saved.source, "dashboard");
	assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(join(evalDirectory, "annotations"))).mode & 0o777, 0o700);
	const ino = (await stat(path)).ino;
	assert.equal((await post(annotation(undefined, { note: "更新" }))).status, 200);
	assert.notEqual((await stat(path)).ino, ino); assert.deepEqual(await readdir(join(evalDirectory, "annotations")), ["synthetic-idle.json"]);
	const detail = await (await fetch(dashboard.baseUrl + "/api/eval/session?id=synthetic-idle", { headers })).json();
	assert.equal(detail.annotation.failSet, true); assert.equal(detail.annotation.note, "更新");
	await mkdir(join(root, "observability")); await writeFile(join(root, "observability/synthetic-idle.trace.jsonl"), "");
	assert.equal((await post(annotation())).status, 409);
	assert.equal(JSON.parse(await readFile(path, "utf8")).note, "更新");
});
test("Eval pagination stays bounded, filters beyond page one and rejects stale detail cursors", async (t) => {
	const { root, dashboard, headers, post } = await api(t);
	for (let i = 0; i < 12; i++) await fixtureSession(root, `synthetic-page-${i}`, { large: i === 0 });
	assert.equal((await post(annotation("synthetic-page-0"))).status, 200);
	let cursor = null, total = 0;
	do {
		const response = await fetch(dashboard.baseUrl + "/api/eval/sessions" + (cursor ? "?cursor=" + cursor : ""), { headers });
		const body = await response.text(); assert.ok(Buffer.byteLength(body) <= MAX_RESPONSE_BYTES);
		const page = JSON.parse(body); total += page.items.length; cursor = page.nextCursor;
	} while (cursor);
	assert.equal(total, 14);
	cursor = null; const matches = [];
	do {
		const page = await (await fetch(dashboard.baseUrl + "/api/eval/sessions?filter=failSet" + (cursor ? "&cursor=" + cursor : ""), { headers })).json();
		matches.push(...page.items); cursor = page.nextCursor;
	} while (cursor);
	assert.equal(matches.length, 1); assert.equal(matches[0].id, "synthetic-page-0");
	assert.equal((await fetch(dashboard.baseUrl + "/api/eval/session?id=" + encodeURIComponent("../x"), { headers })).status, 400);
	const url = dashboard.baseUrl + "/api/eval/session?id=synthetic-page-0";
	const page = await (await fetch(url, { headers })).json(); assert.ok(page.timeline.nextCursor);
	await utimes(join(root, "synthetic-page-0.jsonl"), new Date(), new Date());
	assert.equal((await fetch(url + "&cursor=" + page.timeline.nextCursor, { headers })).status, 409);
	const outside = join(root, "..", "outside.jsonl"); await writeFile(outside, JSON.stringify({ type: "session", id: "outside" }) + "\n");
	await symlink(outside, join(root, "link.jsonl"));
	assert.equal((await post(annotation("outside"))).status, 404);
});

test("annotation storage rejects file and ancestor symlinks without touching their targets", async (t) => {
	const { directory, evalDirectory } = await workspace(t);
	await mkdir(evalDirectory); const target = join(directory, "target"); await mkdir(target);
	await symlink(target, join(evalDirectory, "annotations"));
	await assert.rejects(writeAnnotation(evalDirectory, annotation()), /Symlink/);
	assert.deepEqual(await readdir(target), []);
	await rm(join(evalDirectory, "annotations")); await mkdir(join(evalDirectory, "annotations"));
	const victim = join(target, "victim"); await writeFile(victim, "KEEP");
	await symlink(victim, join(evalDirectory, "annotations/synthetic-idle.json"));
	await assert.rejects(writeAnnotation(evalDirectory, annotation()), /Symlink/);
	await assert.rejects(readAnnotations(evalDirectory), /Symlink/);
	assert.equal(await readFile(victim, "utf8"), "KEEP");
});
test("label merge covers card-only, annotation-only, agreement and conflict; review skips annotations", async (t) => {
	const { root, evalDirectory } = await workspace(t), out = join(evalDirectory, "cards");
	for (const id of ["card", "equal", "conflict", "skip"]) await fixtureSession(root, id);
	await buildCards({ root, out });
	for (const id of ["card", "equal", "conflict"]) {
		const path = join(out, `${id}.md`);
		const card = await readFile(path, "utf8");
		await writeFile(path, card.replace("verdict:\n", "verdict: pass\n"));
	}
	await writeAnnotation(evalDirectory, annotation("equal", { verdict: "pass", note: "", failSet: false }));
	await writeAnnotation(evalDirectory, annotation("conflict"));
	await writeAnnotation(evalDirectory, annotation("annotation-only"));
	await writeAnnotation(evalDirectory, annotation("skip"));
	const merged = await mergedLabels({ out });
	assert.equal(merged.rows.length, 5); assert.equal(merged.conflicts, 1);
	assert.equal(merged.rows.find((row) => row.sessionId === "conflict").verdict, "fail");
	const counts = await collectLabels({ out });
	assert.equal(counts.failSet, 3); assert.equal(counts.conflicts, 1);
	const review = await reviewCards({ out, limit: 10, input: Readable.from(["y\n"]), output: new Writable({ write(_chunk, _encoding, done) { done(); } }) });
	assert.equal(review.remaining, 0); assert.equal(review.pass, 0);
	assert.throws(() => annotationInput(annotation(undefined, { verdict: "pass" })), /Invalid annotation/);
});
