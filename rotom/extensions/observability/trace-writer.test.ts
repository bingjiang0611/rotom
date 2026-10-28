import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LOCAL_TRACE_SCHEMA_V1 } from "./trace-schema.ts";
import { LocalTraceWriterV1, localTracePathForSessionFile } from "./trace-writer.ts";
import { extensionHarness } from "./trace-test-fixtures.ts";

test("trace write failures stay passive and surface through /trace", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-failure-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const blocker = join(root, "not-a-directory");
	writeFileSync(blocker, "block");
	const notices: string[] = [];
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: undefined,
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => join(blocker, "session.jsonl"), getSessionId: () => "failure-session" },
		ui: { notify(message: string) { notices.push(message); } },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.commands.get("trace").handler("", ctx);
	assert.match(notices.at(-1) ?? "", /dropped=1 healthy=false/u);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("trace paths reject directory and file symlinks without touching their targets", async (t) => {
	if (process.platform === "win32") { t.skip("symlink creation is privilege-dependent on Windows"); return; }
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-symlink-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const externalDirectory = join(root, "external-directory");
	const sessionDirectory = join(root, "sessions");
	mkdirSync(externalDirectory, { mode: 0o700 });
	mkdirSync(sessionDirectory, { mode: 0o700 });
	const directorySessionFile = join(sessionDirectory, "directory-session.jsonl");
	writeFileSync(directorySessionFile, "{}\n", { mode: 0o600 });
	symlinkSync(externalDirectory, join(sessionDirectory, "observability"));
	const directoryHarness = extensionHarness();
	const notices: string[] = [];
	const directoryCtx = {
		mode: "print",
		model: undefined,
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => directorySessionFile, getSessionId: () => "directory-symlink" },
		ui: { notify(message: string) { notices.push(message); } },
	};
	await directoryHarness.emit("session_start", { type: "session_start", reason: "startup" }, directoryCtx);
	await directoryHarness.commands.get("trace").handler("", directoryCtx);
	assert.match(notices.at(-1) ?? "", /healthy=false/u);
	assert.deepEqual(existsSync(join(externalDirectory, "directory-session.trace.jsonl")), false);

	rmSync(join(sessionDirectory, "observability"));
	mkdirSync(join(sessionDirectory, "observability"), { mode: 0o700 });
	const fileSessionFile = join(sessionDirectory, "file-session.jsonl");
	writeFileSync(fileSessionFile, "{}\n", { mode: 0o600 });
	const externalFile = join(root, "external-target.txt");
	writeFileSync(externalFile, "unchanged", { mode: 0o640 });
	const externalMode = statSync(externalFile).mode & 0o777;
	symlinkSync(externalFile, localTracePathForSessionFile(fileSessionFile));
	const fileHarness = extensionHarness();
	const fileCtx = {
		...directoryCtx,
		sessionManager: { getSessionFile: () => fileSessionFile, getSessionId: () => "file-symlink" },
	};
	await fileHarness.emit("session_start", { type: "session_start", reason: "startup" }, fileCtx);
	await fileHarness.commands.get("trace").handler("", fileCtx);
	assert.equal(readFileSync(externalFile, "utf8"), "unchanged");
	assert.equal(statSync(externalFile).mode & 0o777, externalMode);
});

test("the persistent writer rejects post-open chmod/replacement and stops queued writes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-writer-integrity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "trace.jsonl");
	writeFileSync(file, "", { mode: 0o600 });
	const record = (name: string) => ({ schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", timestamp: new Date().toISOString(), traceId: "0".repeat(32), spanId: name.padEnd(16, "0").slice(0, 16), name } as any);
	const writer = new LocalTraceWriterV1(file);
	writer.append(record("first"));
	assert.equal(await writer.flush(), true);
	chmodSync(file, 0o644);
	writer.append(record("chmod"));
	assert.equal(await writer.flush(), true);
	assert.equal(writer.healthy, false);
	assert.equal(writer.recordsWritten, 1);
	assert.equal(statSync(file).mode & 0o777, 0o644);
	await writer.close();

	const replacement = join(root, "replacement.jsonl");
	writeFileSync(replacement, "", { mode: 0o600 });
	const second = new LocalTraceWriterV1(replacement);
	second.append(record("first"));
	await second.flush();
	renameSync(replacement, join(root, "old.jsonl"));
	writeFileSync(replacement, "", { mode: 0o600 });
	second.append(record("replaced"));
	await second.flush();
	assert.equal(second.healthy, false);
	assert.equal(readFileSync(replacement, "utf8"), "");
	await second.close();

	let calls = 0;
	const queued = new LocalTraceWriterV1("/unused", async () => { calls += 1; throw new Error("write failed"); });
	queued.append(record("failed")); queued.append(record("must-not-run"));
	assert.equal(await queued.flush(), true);
	assert.equal(calls, 1);
	assert.equal(queued.recordsDropped, 2);
});

test("close drains accepted writes, rejects new appends and closes the pinned descriptor once", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-trace-close-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const writer = new LocalTraceWriterV1(join(root, "trace.jsonl"));
	const record = { schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", name: "fixture" } as any;
	writer.append(record);
	await writer.flush();
	const handle = (writer as any).handle;
	assert.ok(handle);
	const descriptorStats = t.mock.method(handle, "stat");
	writer.append(record);
	await writer.flush();
	assert.equal((writer as any).handle, handle, "flush reuses the descriptor");
	writer.append(record);
	const pending = writer.close();
	writer.append(record);
	assert.equal(await pending, true);
	assert.equal(writer.recordsWritten, 3);
	assert.equal(descriptorStats.mock.callCount(), 0, "open descriptor identity needs no per-write fstat");
	assert.equal(writer.recordsDropped, 1);
	assert.equal(handle.fd, -1);
	assert.equal(await writer.close(), true);
	assert.equal((writer as any).handle, undefined);
});

test("directory permission drift stops an open writer before another record", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-trace-directory-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const writer = new LocalTraceWriterV1(join(root, "trace.jsonl"));
	const record = { schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", name: "fixture" } as any;
	writer.append(record); await writer.flush();
	chmodSync(root, 0o755);
	writer.append(record); await writer.close();
	assert.equal(writer.recordsWritten, 1);
	assert.equal(writer.healthy, false);
});

test("symlink replacement of an open file or its parent stops subsequent writes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-trace-symlink-drift-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const target of ["file", "directory"]) {
		const directory = join(root, target);
		mkdirSync(directory, { mode: 0o700 });
		const path = join(directory, "trace.jsonl");
		const writer = new LocalTraceWriterV1(path);
		const record = { schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", name: "fixture" } as any;
		writer.append(record); await writer.flush();
		const replaced = target === "file" ? path : directory;
		renameSync(replaced, `${replaced}.original`);
		symlinkSync(`${replaced}.original`, replaced);
		writer.append(record); await writer.close();
		assert.equal(writer.healthy, false, target);
		assert.equal(writer.recordsWritten, 1, target);
	}
});

test("flush has a bounded best-effort deadline", async () => {
	const writer = new LocalTraceWriterV1("/unused/trace.jsonl", async () => new Promise<void>(() => {}));
	writer.append({ schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", timestamp: new Date().toISOString(), traceId: "0".repeat(32), spanId: "0".repeat(16), name: "stalled" } as any);
	const started = Date.now();
	assert.equal(await writer.flush(20), false);
	assert.ok(Date.now() - started < 500);
	assert.equal(writer.healthy, false);
	assert.equal(writer.recordsDropped, 1);
});

test("ephemeral sessions and explicit disable do not create trace files", async (t) => {
	const previous = process.env.ROTOM_OBSERVABILITY;
	t.after(() => {
		if (previous === undefined) delete process.env.ROTOM_OBSERVABILITY;
		else process.env.ROTOM_OBSERVABILITY = previous;
	});
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-disabled-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notices: string[] = [];
	const harness = extensionHarness();
	const ctx: any = {
		mode: "print",
		model: undefined,
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => "ephemeral" },
		ui: { notify(message: string) { notices.push(message); } },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.commands.get("trace").handler("", ctx);
	assert.match(notices.at(-1) ?? "", /ephemeral-session/u);

	process.env.ROTOM_OBSERVABILITY = "0";
	const sessionFile = join(root, "session.jsonl");
	chmodSync(root, 0o700);
	ctx.sessionManager.getSessionFile = () => sessionFile;
	await harness.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
	await harness.commands.get("trace").handler("", ctx);
	assert.match(notices.at(-1) ?? "", /disabled-by-ROTOM_OBSERVABILITY/u);
	assert.throws(() => readFileSync(localTracePathForSessionFile(sessionFile), "utf8"), /ENOENT/u);
});
