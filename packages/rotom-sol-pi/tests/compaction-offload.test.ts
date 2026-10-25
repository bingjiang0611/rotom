import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createOffloadSession, result } from "./compaction-offload-session.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadSolPiConfig } from "../src/sol-pi/config.ts";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { OFFLOAD_ENTRY, OFFLOAD_MIN_BYTES, OFFLOAD_TARGET_RATIO, offloadCandidate, offloadPlaceholderFor,
	offloadRecords, selectOffloadCandidates } from "../src/sol-pi/extensions/observation-pack/offload.ts";
import { createObservation, estimateTokens, THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";
import { FakePi, FakeSessionManager, fakeContext, type ToolContext } from "./helpers.ts";

const directories: string[] = [];
async function temp() {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-offload-test-"));
	directories.push(root);
	return root;
}
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function body(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
async function recallAll(pi: FakePi, ctx: ToolContext, id: string): Promise<string> {
	let text = "";
	let offset = 0;
	for (;;) {
		const page = await pi.tool("obs_recall").execute("recall", { id, offset }, undefined, undefined, ctx);
		text += (page.content[0] as { text: string }).text.split("\n").slice(2).join("\n");
		const details = page.details as { eof: boolean; nextOffset: number };
		if (details.eof) return text;
		expect(details.nextOffset).toBeGreaterThan(offset);
		offset = details.nextOffset;
	}
}
async function fixture(real = false) {
	const dir = await temp();
	const manager = real ? SessionManager.create(dir, join(dir, "sessions")) : new FakeSessionManager([], "synthetic", dir);
	manager.appendMessage({ role: "user", content: "synthetic request", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("synthetic response"));
	const pi = new FakePi(manager as FakeSessionManager);
	const ctx = fakeContext(manager as FakeSessionManager, {
		getContextUsage: () => ({ contextWindow: 4000, tokens: 3600, percent: 90, usageTokens: 3600, trailingTokens: 0 }),
	});
	createObservationPackExtension({ compactionOffload: true })(pi.asExtensionApi());
	await pi.emit("session_start", {}, ctx);
	const messages = [result(8192, "call-a"), result(8192, "call-b")];
	const event = { type: "session_before_compact", reason: "threshold", preparation: {
		messagesToSummarize: [messages[0]], turnPrefixMessages: [messages[1]],
		tokensBefore: 4500, settings: { reserveTokens: 500 },
	} };
	const ledger = async () => (await readFile(join(runtimeRoot(ctx), "observation-pack/ledger.jsonl"), "utf8"))
		.trim().split("\n").map((line) => JSON.parse(line));
	return { pi, ctx, manager, event, messages, ledger };
}

describe("compaction offload selection and placeholder", () => {
	it.each([[1536, false], [1537, true], [10240, true], [10241, false]])("selects UTF-8 boundary %i", (bytes, selected) => {
		const message = result(bytes as number);
		expect(!!offloadCandidate(message, "/unused")).toBe(selected);
	});
	it("uses UTF-8 bytes, complete lines and <=512 bytes; skips uneconomic or oversized headers", () => {
		const message = result();
		message.content = [{ type: "text", text: "中文行\n".repeat(300) }];
		const candidate = offloadCandidate(message, "/unused")!;
		expect(candidate.observation.bytes).toBe(3000);
		expect(Buffer.byteLength(candidate.placeholder)).toBeLessThanOrEqual(512);
		expect(candidate.placeholder).toContain('retrieve: call obs_recall with {"id":');
		expect(candidate.placeholder.split("next_offset\n")[1]).toMatch(/^(中文行\n)+$/u);
		expect(offloadPlaceholderFor({ ...candidate.observation, text: "x", bytes: 100 })).toBeUndefined();
		expect(offloadPlaceholderFor({ ...candidate.observation, toolName: "a".repeat(600) })).toBeUndefined();
	});
	it("excludes error, image, recall, reducer receipts, duplicates and offloaded calls", () => {
		const ordinary = result();
		const image = { ...ordinary, content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }] };
		const receipt = { ...ordinary, content: [{ type: "text" as const, text: "sol_pi_evidence_receipt_v1\n" + body(ordinary) }] };
		for (const message of [{ ...ordinary, isError: true }, image, receipt, result(8192, "recall", "obs_recall")]) {
			expect(offloadCandidate(message, "/unused")).toBeUndefined();
		}
		expect(selectOffloadCandidates([ordinary, ordinary], "/unused", new Set())).toHaveLength(1);
		expect(selectOffloadCandidates([ordinary], "/unused", new Set([ordinary.toolCallId]))).toHaveLength(0);
		expect(createObservation(ordinary, "/unused")).toBeUndefined();
		expect(createObservation(result(10241), "/unused")).toEqual(createObservation(result(10241), "/unused", THRESHOLD_BYTES));
	});
});

describe("compaction offload handlers", () => {
	it("disabled adds no lifecycle handlers and preserves the existing context output", async () => {
		const manager = new FakeSessionManager([], "disabled", await temp());
		const ctx = fakeContext(manager);
		const pi = new FakePi(manager);
		createObservationPackExtension()(pi.asExtensionApi());
		expect([...pi.handlers.keys()]).toEqual(["context"]);
		expect(await pi.emitContext([result()], ctx)).toEqual([result()]);
	});
	it("stores before recording; includes turn prefix; projects immediately; recalls exact bytes; stale then fresh usage", async () => {
		const { pi, ctx, manager, event, messages, ledger } = await fixture();
		expect(OFFLOAD_MIN_BYTES).toBe(1536);
		expect(OFFLOAD_TARGET_RATIO).toBe(0.6);
		expect(await pi.emit("session_before_compact", event, ctx)).toEqual({ cancel: true });
		const records = offloadRecords(manager.getBranch());
		expect(records).toHaveLength(1);
		expect(records[0]!.toolCallIds).toEqual(["call-a", "call-b"]);
		expect(records[0]!.estimatedTokensAfter).toBe(4500 - messages.reduce((sum, m) => {
			const c = offloadCandidate(m, runtimeRoot(ctx))!;
			return sum + c.observation.tokens - estimateTokens(c.placeholder);
		}, 0));
		const projected = await pi.emitContext(messages, ctx);
		expect(body(projected[0]!)).toContain("[older tool result offloaded before compaction]");
		expect(body(messages[0]!)).not.toContain("offloaded");
		expect(await recallAll(pi, ctx, records[0]!.observationIds[0]!)).toBe(body(messages[0]!));
		expect(await pi.emit("session_before_compact", event, ctx)).toEqual({ cancel: true });
		expect(offloadRecords(manager.getBranch())).toHaveLength(1);
		manager.appendMessage(fauxAssistantMessage("new usage"));
		expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
		expect((await ledger()).map((r) => r.event)).toContain("offload_defer_stale");
		expect((await ledger()).at(-1).reason).toBe("no_candidates");
	});
	it.each(["manual", "extension", "overflow"])("does nothing for %s", async (reason) => {
		const { pi, ctx, event, manager } = await fixture();
		expect(await pi.emit("session_before_compact", { ...event, reason }, ctx)).toBeUndefined();
		expect(offloadRecords(manager.getBranch())).toHaveLength(0);
		await expect(readFile(join(runtimeRoot(ctx), "observation-pack/ledger.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each(["no_context_window", "no_candidates", "insufficient_savings"])("keeps native compaction: %s", async (reason) => {
		const { pi, ctx, event, manager, ledger } = await fixture();
		if (reason === "no_context_window") ctx.getContextUsage = () => undefined;
		if (reason === "no_candidates") event.preparation.messagesToSummarize = event.preparation.turnPrefixMessages = [];
		if (reason === "insufficient_savings") event.preparation.tokensBefore = 10000;
		expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
		expect(offloadRecords(manager.getBranch())).toHaveLength(0);
		expect((await ledger()).at(-1)).toMatchObject({ event: "offload_native", reason });
	});
	it("falls back to model.contextWindow", async () => {
		const { pi, ctx, event } = await fixture();
		ctx.getContextUsage = () => undefined;
		ctx.model = fauxProvider({ models: [{ id: "fallback", contextWindow: 4000 }] }).getModel();
		expect(await pi.emit("session_before_compact", event, ctx)).toEqual({ cancel: true });
	});
	it.each(["directory", "symlink", "hash"])("store failure %s leaves no record", async (kind) => {
		const { pi, ctx, event, manager, messages, ledger } = await fixture();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const observation = offloadCandidate(messages[1]!, runtimeRoot(ctx))!.observation;
		await mkdir(dirname(observation.filePath), { recursive: true });
		if (kind === "directory") await mkdir(observation.filePath);
		if (kind === "symlink") await symlink("/nonexistent-synthetic-target", observation.filePath);
		if (kind === "hash") await writeFile(observation.filePath, "z".repeat(observation.bytes));
		expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
		expect(offloadRecords(manager.getBranch())).toHaveLength(0);
		expect((await ledger()).at(-1).reason).toBe("store_failed");
	});
	it.each(["missing", "hash"])("projection failure %s retains original", async (kind) => {
		const { pi, ctx, event, messages } = await fixture();
		vi.spyOn(console, "error").mockImplementation(() => {});
		await pi.emit("session_before_compact", event, ctx);
		const observation = offloadCandidate(messages[0]!, runtimeRoot(ctx))!.observation;
		if (kind === "missing") await rm(observation.filePath);
		else await writeFile(observation.filePath, "z".repeat(observation.bytes));
		expect((await pi.emitContext(messages, ctx))[0]).toEqual(messages[0]);
	});
	it("real EISDIR append is unknown, never stale-cancels (including tree), but exact recall remains possible", async () => {
		const { pi, ctx, event, manager, messages, ledger } = await fixture(true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const file = manager.getSessionFile()!;
		await rename(file, `${file}.saved`);
		await mkdir(file);
		expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
		expect((await ledger()).at(-1).reason).toBe("record_append_failed");
		const records = offloadRecords(manager.getBranch());
		expect(records).toHaveLength(1);
		for (const m of messages) {
			const observation = offloadCandidate(m, runtimeRoot(ctx))!.observation;
			expect(await readFile(observation.filePath, "utf8")).toBe(body(m));
		}
		expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
		await pi.emit("session_tree", {}, ctx);
		expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
		expect((await ledger()).some((r) => r.event === "offload_defer_stale")).toBe(false);
		expect(body((await pi.emitContext(messages, ctx))[0]!)).toContain("offloaded before compaction");
		expect(await recallAll(pi, ctx, records[0]!.observationIds[0]!)).toBe(body(messages[0]!));
		await rm(file, { recursive: true });
		await rename(`${file}.saved`, file);
		const reopened = SessionManager.open(file);
		expect(offloadRecords(reopened.getBranch())).toHaveLength(0);
		const resumedCtx = { ...ctx, sessionManager: reopened } as ExtensionContext;
		await pi.emit("session_start", {}, resumedCtx);
		expect(await pi.emitContext(messages, resumedCtx)).toEqual(messages);
	});
	it("ledger failure after append does not cancel or confirm the defer", async () => {
		const { pi, ctx, event, manager } = await fixture();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const path = join(runtimeRoot(ctx), "observation-pack/ledger.jsonl");
		await mkdir(path, { recursive: true });
		expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
		expect(offloadRecords(manager.getBranch())).toHaveLength(1);
		await rm(path, { recursive: true });
		expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
	});
	it("forked sessions do not borrow archives from another runtime root", async () => {
		const { pi, ctx, event, manager, messages } = await fixture(true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		await pi.emit("session_before_compact", event, ctx);
		const dir = await temp();
		const fork = SessionManager.forkFrom(manager.getSessionFile()!, dir, join(dir, "sessions"));
		const forkCtx = fakeContext(fork as unknown as FakeSessionManager);
		await pi.emit("session_start", {}, forkCtx);
		expect(runtimeRoot(forkCtx)).not.toBe(runtimeRoot(ctx));
		expect(await pi.emitContext(messages, forkCtx)).toEqual(messages);
	});
	it("tree changes use only their own records; resume restores successful defer", async () => {
		const { pi, ctx, event, manager, messages } = await fixture(true);
		const oldLeaf = manager.getLeafId()!;
		await pi.emit("session_before_compact", event, ctx);
		const newLeaf = manager.getLeafId()!;
		const reopened = SessionManager.open(manager.getSessionFile()!);
		const resumed = new FakePi(reopened as unknown as FakeSessionManager);
		const resumedCtx = { ...ctx, sessionManager: reopened } as ExtensionContext;
		createObservationPackExtension({ compactionOffload: true })(resumed.asExtensionApi());
		await resumed.emit("session_start", {}, resumedCtx);
		expect(body((await resumed.emitContext(messages, resumedCtx))[0]!)).toContain("offloaded before compaction");
		expect(await resumed.emit("session_before_compact", event, resumedCtx)).toEqual({ cancel: true });
		reopened.branch(oldLeaf);
		await resumed.emit("session_tree", {}, resumedCtx);
		expect(await resumed.emitContext(messages, resumedCtx)).toEqual(messages);
		reopened.branch(newLeaf);
		await resumed.emit("session_tree", {}, resumedCtx);
		expect(body((await resumed.emitContext(messages, resumedCtx))[0]!)).toContain("offloaded before compaction");
	});
});

describe("compaction offload configuration", () => {
	it.each([{ compactionOffload: true }, { compactionOffload: true, observationPack: false }, { compactionOffload: "true" }])("rejects invalid config %j in loader and CLI", async (config) => {
		const dir = await temp();
		const path = join(dir, "sol-pi.json");
		await writeFile(path, JSON.stringify({ version: 1, ...config }));
		expect(() => loadSolPiConfig(dir, dir)).toThrow(/compactionOffload/u);
		const run = spawnSync(process.execPath, ["scripts/check-sol-pi-config.mjs", "--config", path], { encoding: "utf8" });
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("compactionOffload");
	});
	it("defaults off and enables only with observationPack", async () => {
		expect(DEFAULT_CONFIG.compactionOffload).toBe(false);
		const dir = await temp();
		const path = join(dir, "sol-pi.json");
		await writeFile(path, JSON.stringify({ version: 1, compactionOffload: true, observationPack: true }));
		expect(loadSolPiConfig(dir, dir).compactionOffload).toBe(true);
		expect(JSON.parse(execFileSync(process.execPath, ["scripts/check-sol-pi-config.mjs", "--config", path], { encoding: "utf8" })).effective_config.compactionOffload).toBe(true);
	});
});

describe("compaction offload AgentSession scenarios", () => {
	it("A/D: defers threshold and stale usage, retains recent results, recalls, and restores from disk", async () => {
		const f = await createOffloadSession(await temp(), [8192, 8192, 2048], 3000, 6500, "done".repeat(2000));
		let resumed: AgentSession | undefined;
		try {
			await f.session.prompt("synthetic work");
			expect(f.manager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
			expect(offloadRecords(f.manager.getBranch())).toHaveLength(1);
			expect(f.summaryCalls()).toBe(0);
			const recordAtEnd = offloadRecords(f.manager.getBranch())[0]!;
			expect(recordAtEnd.afterAssistantEntryId).toBe(f.manager.getBranch().findLast((e) => e.type === "message" && e.message.role === "assistant")!.id);
			expect(recordAtEnd.toolCallIds.every((id) => f.preparations[0]!.ids.includes(id))).toBe(true);
			await f.session.prompt("next request");
			expect(f.summaryCalls()).toBe(0);
			const root = runtimeRoot(fakeContext(f.manager as unknown as FakeSessionManager));
			expect(await readFile(join(root, "observation-pack/ledger.jsonl"), "utf8")).toContain('"event":"offload_defer_stale"');
			const sent = f.requests.at(-1)!.filter((m) => m.role === "toolResult");
			expect(body(sent[0]!)).toContain("offloaded before compaction");
			expect(body(sent.at(-1)!)).toBe(body(result(2048)));
			const raw = f.manager.getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult");
			expect(raw.some((e) => e.type === "message" && body(e.message).includes("offloaded"))).toBe(false);
			f.session.dispose();
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			resumed = await f.open(reopened);
			await resumed.prompt("resume request");
			expect(body(f.requests.at(-1)!.find((m) => m.role === "toolResult")!)).toContain("offloaded before compaction");
			const ctx = fakeContext(reopened as unknown as FakeSessionManager);
			const pi = new FakePi(reopened as unknown as FakeSessionManager);
			createObservationPackExtension({ compactionOffload: true })(pi.asExtensionApi());
			const record = offloadRecords(reopened.getBranch())[0]!;
			expect(await recallAll(pi, ctx, record.observationIds[0]!)).toBe(body(result(8192)));
		} finally { f.session.dispose(); resumed?.dispose(); }
	}, 20000);
	it.each(["small", "retained"])("B: native compaction when %s results cannot save enough", async (kind) => {
		const f = await createOffloadSession(await temp(), kind === "small" ? [100, 100] : [8192, 8192, 2048], kind === "retained" ? 4200 : 400);
		try {
			if (kind === "small") f.largeReply();
			await f.session.prompt("synthetic work");
			expect(f.manager.getBranch().filter((e) => e.type === "compaction").length).toBeGreaterThan(0);
			expect(offloadRecords(f.manager.getBranch())).toHaveLength(0);
			expect(f.summaryCalls()).toBeGreaterThan(0);
		} finally { f.session.dispose(); }
	}, 20000);
	it("C: fresh over-threshold usage without new candidates runs native compaction", async () => {
		const f = await createOffloadSession(await temp(), [8192, 100], 20, 3100, "done".repeat(1000));
		try {
			await f.session.prompt("synthetic work");
			expect(offloadRecords(f.manager.getBranch())).toHaveLength(1);
			f.largeReply();
			await f.session.prompt("produce a large reply");
			expect(f.manager.getBranch().filter((e) => e.type === "compaction").length).toBeGreaterThan(0);
			expect(offloadRecords(f.manager.getBranch())).toHaveLength(1);
			expect(f.summaryCalls()).toBeGreaterThan(0);
			const ctx = fakeContext(f.manager as unknown as FakeSessionManager);
			const ledger = (await readFile(join(runtimeRoot(ctx), "observation-pack/ledger.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			expect(ledger.at(-1)).toMatchObject({ event: "offload_native", reason: "no_candidates" });
		} finally { f.session.dispose(); }
	}, 20000);
});
