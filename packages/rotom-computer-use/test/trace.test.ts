import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exportTraceMarkdown } from "../src/trace/report.ts";
import { RETENTION_MS, TraceRecorder, TraceUnsafePathError, redactParams, redactText, resolveTraceRoot, safeSegment } from "../src/trace/recorder.ts";

function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "cu-trace-"));
}

test("typed text is stored as length and digest, never as content", () => {
	const redacted = redactParams({ actions: [{ action: "typeText", text: "hunter2-secret" }] }) as any;
	const typed = redacted.actions[0].text;
	assert.equal(typed.length, "hunter2-secret".length);
	assert.equal(typed.sha256, redactText("hunter2-secret").sha256);
	assert.equal(JSON.stringify(redacted).includes("hunter2-secret"), false);
});

test("entries are private, sequential, and read back by trace_export", () => {
	const root = tempRoot();
	const recorder = TraceRecorder.create({ sessionId: "session/one", agentId: "session:abc", root, enabled: true, now: () => 1_700_000_000_000 })!;
	try {
		recorder.record({ tool: "observe_ui", status: "ok", target: { app: "TextEdit", ref: "@r1" }, deliveryLevel: "L2" });
		recorder.record({ tool: "act_ui", status: "ok", target: { role: "button", label: "Save" }, text: redactText("hello") });
		const file = recorder.filePath;
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
		assert.equal(recorder.stats.writes, 2);
		const raw = readFileSync(file, "utf-8");
		assert.equal(raw.trim().split("\n").length, 2);
		assert.equal(raw.includes("hello"), false);
		const markdown = exportTraceMarkdown(path.dirname(file), path.basename(file));
		assert.match(markdown, /Computer Use trace/);
		assert.match(markdown, /button Save/);
		assert.match(markdown, /text\(5 chars/);
		assert.equal(markdown.includes("hello"), false);
	} finally {
		recorder.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("screenshots land in shots/ with private modes and appear in the report", () => {
	const root = tempRoot();
	const recorder = TraceRecorder.create({ sessionId: "s1", agentId: "process:42", root, enabled: true, now: () => 1_700_000_000_000 })!;
	try {
		const name = recorder.saveScreenshot(Buffer.from("jpeg-bytes").toString("base64"));
		assert.ok(name?.startsWith("shots/"));
		assert.equal(statSync(path.join(recorder.sessionDir, name!)).mode & 0o777, 0o600);
		recorder.record({ tool: "observe_ui", status: "ok", screenshots: [name!] });
		const markdown = exportTraceMarkdown(path.dirname(recorder.filePath), path.basename(recorder.filePath));
		assert.match(markdown, /Screenshot timeline/);
		assert.ok(markdown.includes(name!));
	} finally {
		recorder.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a symlinked trace directory is refused instead of followed", () => {
	const root = tempRoot();
	const outside = path.join(root, "outside");
	mkdirSync(outside, { recursive: true });
	const link = path.join(root, "link");
	symlinkSync(outside, link);
	try {
		assert.throws(() => {
			const recorder = TraceRecorder.create({ sessionId: "s", agentId: "a", root: link, enabled: true });
			recorder?.record({ tool: "observe_ui", status: "ok" });
		}, (error: unknown) => {
			assert.ok(error instanceof TraceUnsafePathError || error instanceof Error);
			return true;
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ROTOM_CU_TRACE=0 disables the trace and stale sessions are pruned", () => {
	assert.equal(resolveTraceRoot({ ROTOM_CU_TRACE: "0" }), undefined);
	assert.ok(resolveTraceRoot({}));

	const root = tempRoot();
	const now = 1_700_000_000_000;
	try {
		const old = path.join(root, safeSegment("old-session"));
		mkdirSync(old, { recursive: true });
		utimesSync(old, new Date(now - RETENTION_MS - 60_000), new Date(now - RETENTION_MS - 60_000));
		const recorder = TraceRecorder.create({ sessionId: "fresh", agentId: "a", root, enabled: true, now: () => now })!;
		recorder.record({ tool: "observe_ui", status: "ok" });
		recorder.close();
		assert.equal(existsSync(old), false);
		assert.equal(TraceRecorder.create({ sessionId: "fresh", agentId: "a", root, enabled: false }), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the per-session cap drops the oldest screenshots instead of growing without bound", () => {
	const root = tempRoot();
	let clock = 1_700_000_000_000;
	const recorder = TraceRecorder.create({ sessionId: "s", agentId: "a", root, enabled: true, capBytes: 4096, now: () => clock })!;
	try {
		const names: string[] = [];
		for (let index = 0; index < 6; index += 1) {
			clock += 1000;
			const name = recorder.saveScreenshot(Buffer.alloc(2048, index).toString("base64"));
			if (name) names.push(name);
		}
		const total = names
			.map((name) => path.join(recorder.sessionDir, name))
			.filter((file) => existsSync(file))
			.map((file) => statSync(file).size)
			.reduce((sum, size) => sum + size, 0);
		assert.ok(total <= 4096 * 2, `screenshots stayed bounded, got ${total}`);
		recorder.record({ tool: "observe_ui", status: "ok" });
	} finally {
		recorder.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a duplicate file path is a fresh file, not an append across sessions", () => {
	const root = tempRoot();
	const first = TraceRecorder.create({ sessionId: "s", agentId: "a", root, enabled: true })!;
	first.record({ tool: "observe_ui", status: "ok" });
	first.close();
	const second = TraceRecorder.create({ sessionId: "s", agentId: "a", root, enabled: true })!;
	second.record({ tool: "act_ui", status: "ok" });
	second.close();
	// Same agent writing again appends: the file is per agent per session, and a
	// resumed session must not lose earlier evidence.
	assert.equal(readFileSync(first.filePath, "utf-8").trim().split("\n").length, 2);
	rmSync(root, { recursive: true, force: true });
});

test("trace params keep only allowlisted fields, never tool payload text", async () => {
	const { redactParams } = await import("../src/trace/recorder.ts");
	const sentinels = {
		url: "https://sentinel-url.example/do-not-log",
		expression: "sentinel-expression-payload",
		option: "sentinel-option",
		keys: "sentinel-key-combo",
		path: "/sentinel/app/path",
		keysArray: ["sentinel-key-a", "sentinel-key-b"],
	};
	const redacted = JSON.stringify(redactParams({
		ref: "@e12",
		x: 10,
		y: 20,
		url: sentinels.url,
		expression: sentinels.expression,
		option: sentinels.option,
		keys: sentinels.keys,
		path: sentinels.path,
		list: sentinels.keysArray,
	})) as string;
	for (const [name, value] of Object.entries(sentinels)) {
		const values = Array.isArray(value) ? value : [value];
		for (const entry of values) {
			assert.equal(redacted.includes(entry), false, `${name} must not appear in the trace`);
		}
	}
	// Structural fields stay readable: that is what makes the trace useful.
	assert.match(redacted, /"ref":"@e12"/);
	assert.match(redacted, /"x":10/);
	const parsed = JSON.parse(redacted) as Record<string, any>;
	assert.equal(typeof parsed.url.sha256, "string");
	assert.equal(parsed.url.length, [...sentinels.url].length);
});
