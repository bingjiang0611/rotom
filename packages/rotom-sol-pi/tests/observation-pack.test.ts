/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createObservationPackExtension,
	FULL_SENDS,
	THRESHOLD_BYTES,
} from "../src/sol-pi/extensions/observation-pack/index.ts";
import { componentText, FakePi, FakeSessionManager, fakeContext, plainTheme, type ToolContext } from "./helpers.ts";
import type { RecallChunk } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";

const roots: string[] = [];
const SESSION_ID = "session-a";

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

async function sessionRoot(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "observationpack-test-"));
	roots.push(value);
	return value;
}

function observationPackPi(): FakePi {
	const pi = new FakePi();
	createObservationPackExtension()(pi.asExtensionApi());
	return pi;
}

function repeatPastThreshold(line: string): string {
	return line.repeat(Math.ceil((THRESHOLD_BYTES + 1) / Buffer.byteLength(line, "utf8")));
}

function toolResult(text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...overrides,
	};
}

function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") throw new Error("expected tool result");
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function observationId(message: ToolResultMessage): string {
	const contentHash = createHash("sha256").update(resultText(message)).digest("hex");
	const identity = `${message.toolName}\0${message.toolCallId}\0${contentHash}`;
	return `obs_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function observationPath(sessionDir: string, id: string): string {
	return join(sessionDir, "sol-pi", SESSION_ID, "observation-pack", "objects", `${id}.txt`);
}

function observationObjectsDirectory(sessionDir: string): string {
	return join(sessionDir, "sol-pi", SESSION_ID, "observation-pack", "objects");
}

async function project(pi: FakePi, message: ToolResultMessage, sessionDir: string, count: number): Promise<string[]> {
	const projected: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const messages = await pi.emitContext([message], fakeContext(sessionDir));
		const result = messages[0];
		if (!result) throw new Error("missing projection");
		projected.push(resultText(result));
	}
	return projected;
}

async function recallPage(
	pi: FakePi, id: string, offset: number, ctx: ToolContext, toolCallId = "recall-1",
): Promise<Omit<ToolResultMessage, "details"> & { details: Pick<RecallChunk, "nextOffset" | "eof"> }> {
	const result = await pi.tool("obs_recall").execute(toolCallId, { id, offset }, undefined, undefined, ctx);
	expect(result).not.toHaveProperty("isError", true);
	expect(result.details).toEqual(expect.objectContaining({ nextOffset: expect.any(Number), eof: expect.any(Boolean) }));
	const details = result.details as Pick<RecallChunk, "nextOffset" | "eof">;
	return { ...toolResult("", { ...result, details, toolName: "obs_recall", toolCallId }), details };
}

function captureConsoleErrors(): string[] {
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
		errors.push(values.map(String).join(" "));
	});
	return errors;
}

describe("observation pack", () => {
	it("archives and recalls large observations without a session directory", async () => {
		const manager = SessionManager.inMemory();
		const context = fakeContext("", { sessionManager: manager });
		const root = runtimeRoot(context);
		roots.push(root);
		const body = `in-memory observation\n${repeatPastThreshold("recall bytes\n")}`;
		const message = toolResult(body);
		const pi = observationPackPi();
		for (let index = 0; index < FULL_SENDS; index++) {
			expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(body);
		}
		const placeholder = resultText((await pi.emitContext([message], context))[0]!);
		const id = placeholder.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBeTruthy();
		expect(await readFile(join(root, "observation-pack", "objects", `${id}.txt`), "utf8")).toBe(body);
		const recalled = await observationPackPi().tool("obs_recall").execute(
			"recall-memory", { id, offset: 0 }, undefined, undefined,
			fakeContext("", { sessionManager: manager }),
		);
		expect(recalled.content).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "text", text: expect.stringContaining("in-memory observation") }),
		]));
		expect(manager.getSessionFile()).toBeUndefined();
	});

	it("registers its public surface without legacy environment flags", () => {
		const pi = observationPackPi();
		expect(pi.handlers.has("context")).toBe(true);
		expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["obs_recall"]);
	});

	it("renders observation recall as an English lightning savings call", () => {
		const recall = observationPackPi().tool("obs_recall");
		const args = { id: "obs_0123456789abcdef01234567", offset: 0 };
		const rendered = recall.renderCall!(args, plainTheme, { args, cwd: process.cwd() } as never);

		expect(componentText(rendered)).toContain("⚡ SoL-Pi · Observation Pack");
		expect(componentText(rendered)).toContain("Money saved");
	});

	it("keeps the first two requests full and reuses one stable placeholder afterwards", async () => {
		const sessionDir = await sessionRoot();
		const body = `head line\n${repeatPastThreshold("middle line\n")}tail line\n`;
		const message = toolResult(body);
		const projected = await project(observationPackPi(), message, sessionDir, 4);

		expect(FULL_SENDS).toBe(2);
		expect(projected[0]).toBe(body);
		expect(projected[1]).toBe(body);
		expect(projected[2]).not.toBe(body);
		expect(projected[2]).toBe(projected[3]);
		expect(projected[2]).toMatch(/^\[large tool result replaced/u);
		expect(projected[2]).toMatch(/head line/u);
		expect(projected[2]).toMatch(/tail line/u);
		expect(resultText(message)).toBe(body);

		const id = projected[2]?.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBeTruthy();
		expect(await readFile(observationPath(sessionDir, id!), "utf8")).toBe(body);
	});

	it("announces the first measured placeholder saving only in TUI mode", async () => {
		vi.useFakeTimers();
		const sessionDir = await sessionRoot();
		const body = `head line\n${repeatPastThreshold("middle line\n")}tail line\n`;
		const message = toolResult(body);
		const pi = observationPackPi();
		const notify = vi.fn();
		const setStatus = vi.fn();
		const context = fakeContext(sessionDir, {
			mode: "tui",
			hasUI: true,
			ui: { notify, setStatus } as never,
		});

		await pi.emitContext([message], context);
		await pi.emitContext([message], context);
		await pi.emitContext([message], context);
		await pi.emitContext([message], context);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatch(
			/^⚡ SoL-Pi · Observation Pack\nMoney saved · [\d,]+ context tokens avoided$/u,
		);
	});

	it("isolates objects and send counters by Pi session", async () => {
		const sessionDir = await sessionRoot();
		const body = `session isolation\n${repeatPastThreshold("separate bytes\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		const pi = observationPackPi();
		const contextA = fakeContext(new FakeSessionManager([], "session-a", sessionDir));
		const contextB = fakeContext(new FakeSessionManager([], "session-b", sessionDir));

		for (const context of [contextA, contextB]) {
			expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(body);
			expect(resultText((await pi.emitContext([message], context))[0]!)).toBe(body);
			expect(resultText((await pi.emitContext([message], context))[0]!)).toMatch(/^\[large tool result replaced/u);
		}

		expect(await readFile(join(sessionDir, "sol-pi", "session-a", "observation-pack", "objects", `${id}.txt`), "utf8")).toBe(body);
		expect(await readFile(join(sessionDir, "sol-pi", "session-b", "observation-pack", "objects", `${id}.txt`), "utf8")).toBe(body);
	});

	it("breaks the prefix once per observation without remutating older placeholders", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const first = toolResult(`first\n${"a".repeat(THRESHOLD_BYTES + 100)}\n`, { toolCallId: "first" });
		const second = toolResult(`second\n${"b".repeat(THRESHOLD_BYTES + 100)}\n`, { toolCallId: "second" });
		const firstSends = await project(pi, first, sessionDir, 3);
		const oldPlaceholder = firstSends[2];
		expect(oldPlaceholder).toBeTruthy();

		const combined: string[][] = [];
		for (let index = 0; index < 3; index += 1) {
			const messages = await pi.emitContext([first, second], fakeContext(sessionDir));
			combined.push(messages.map(resultText));
		}

		expect(combined[0]?.[0]).toBe(oldPlaceholder);
		expect(combined[1]?.[0]).toBe(oldPlaceholder);
		expect(combined[2]?.[0]).toBe(oldPlaceholder);
		expect(combined[0]?.[1]).toBe(resultText(second));
		expect(combined[1]?.[1]).toBe(resultText(second));
		expect(combined[2]?.[1]).not.toBe(resultText(second));
	});

	it("recalls from durable storage after a restart of the extension", async () => {
		const sessionDir = await sessionRoot();
		const body = `durable observation\n${repeatPastThreshold("recall line\n")}`;
		const projected = await project(observationPackPi(), toolResult(body), sessionDir, 3);
		const id = projected[2]?.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBeTruthy();

		const resumed = observationPackPi();
		const result = await resumed
			.tool("obs_recall")
			.execute("recall-1", { id, offset: 0 }, undefined, undefined, fakeContext(sessionDir));
		const recalled = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

		expect(recalled).toMatch(/durable observation/u);
		expect(recalled).toMatch(/recall line/u);
	});

	it("packs large recall pages into stable source offsets, never new objects", async () => {
		const sessionDir = await sessionRoot();
		const ctx = fakeContext(sessionDir);
		const pi = observationPackPi();
		const original = toolResult("0123456789abcdef".repeat(3_000));
		const id = observationId(original);
		await project(pi, original, sessionDir, 3);
		const page = await recallPage(pi, id, 128, ctx);
		const text = resultText(page);
		expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(THRESHOLD_BYTES);
		const projected = await project(pi, page, sessionDir, 5);
		expect(projected.slice(0, 2)).toEqual([text, text]);
		const placeholder = projected[2]!;
		expect(projected.slice(2)).toEqual([placeholder, placeholder, placeholder]);
		expect(Buffer.byteLength(placeholder, "utf8")).toBeLessThan(1_024);
		expect(placeholder).toContain(`retrieve: call obs_recall with {"id":"${id}","offset":128}`);
		expect(placeholder).toContain(`continue: call obs_recall with {"id":"${id}","offset":${page.details.nextOffset}}`);
		expect(placeholder).not.toContain(observationId(page));
		expect(await readdir(observationObjectsDirectory(sessionDir))).toEqual([`${id}.txt`]);
		expect(resultText(page)).toBe(text);

		// A new call re-reading the same range gets its own full-send budget.
		const reread = await recallPage(pi, id, 128, ctx, "recall-again");
		expect(resultText(reread)).toBe(text);
		expect(await project(pi, reread, sessionDir, 3)).toEqual([text, text, placeholder]);
		const ledger = (await readFile(join(sessionDir, "sol-pi", SESSION_ID, "observation-pack", "ledger.jsonl"), "utf8"))
			.trim().split("\n").map((line) => JSON.parse(line));
		const pageEntries = ledger.filter((entry) => entry.tool === "obs_recall");
		expect(pageEntries).toHaveLength(8);
		for (const entry of pageEntries) {
			expect(entry).toMatchObject({ id, offset: 128, nextOffset: page.details.nextOffset, eof: false });
		}
	});

	it("preserves UTF-8 bytes across packed pages, including a large EOF page", async () => {
		const sessionDir = await sessionRoot();
		const ctx = fakeContext(sessionDir);
		const pi = observationPackPi();
		const body = "界🙂".repeat(6_500);
		const original = toolResult(body);
		const id = observationId(original);
		await project(pi, original, sessionDir, 3);
		let offset = 0;
		let rebuilt = "";
		let eof = false;
		for (let index = 0; index < 10 && !eof; index += 1) {
			const page = await recallPage(pi, id, offset, ctx, `recall-${index}`);
			const text = resultText(page);
			expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(THRESHOLD_BYTES);
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16 * 1_024);
			const [first, second, placeholder] = await project(pi, page, sessionDir, 3);
			expect([first, second]).toEqual([text, text]);
			expect(placeholder).toContain(`retrieve: call obs_recall with {"id":"${id}","offset":${offset}}`);
			const reread = await recallPage(observationPackPi(), id, offset, ctx, `again-${index}`);
			expect(resultText(reread)).toBe(text);
			rebuilt += text.slice(text.indexOf("\n", text.indexOf("\n") + 1) + 1);
			expect(page.details.nextOffset).toBeGreaterThan(offset);
			offset = page.details.nextOffset;
			eof = page.details.eof;
			if (eof) {
				expect(placeholder).toContain("eof: true");
				expect(placeholder).not.toContain("continue:");
				expect(placeholder).toContain("does not prove earlier pages were read");
			}
		}
		expect(eof).toBe(true);
		expect(Buffer.from(rebuilt, "utf8")).toEqual(Buffer.from(body, "utf8"));
		expect(offset).toBe(Buffer.byteLength(body, "utf8"));
		expect(await readdir(observationObjectsDirectory(sessionDir))).toEqual([`${id}.txt`]);
	});

	it("uses original page references after persisted compaction and resume without rewriting history", async () => {
		const sessionDir = await sessionRoot();
		const manager = SessionManager.create(sessionDir, sessionDir);
		const ctx = fakeContext(sessionDir, { sessionManager: manager });
		const pi = observationPackPi();
		const original = toolResult("source bytes ".repeat(3_000));
		const id = observationId(original);
		manager.appendMessage({ role: "user", content: "read a page", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage(fauxToolCall("bash", {}, { id: original.toolCallId }), { stopReason: "toolUse" }));
		manager.appendMessage(original);
		await pi.emitContext(manager.buildSessionContext().messages, ctx);
		manager.appendMessage(fauxAssistantMessage(fauxToolCall("obs_recall", { id, offset: 128 }, { id: "recall-1" }), { stopReason: "toolUse" }));
		const page = await recallPage(pi, id, 128, ctx);
		const keptId = manager.appendMessage(page);
		manager.appendMessage(fauxAssistantMessage("first request after recall"));
		const beforeCompaction = manager.appendMessage(fauxAssistantMessage("second request after recall"));
		manager.appendCompaction("Only one page was inspected.", keptId, 40_000);
		const sessionFile = manager.getSessionFile()!;
		const persisted = await readFile(sessionFile, "utf8");
		const resumed = SessionManager.open(sessionFile, sessionDir);
		const resumedCtx = fakeContext(sessionDir, { sessionManager: resumed });
		const history = resumed.buildSessionContext().messages;
		expect(history.some((message) => message.role === "toolResult" && message.toolCallId === original.toolCallId)).toBe(false);
		const freshPi = observationPackPi();
		const projected = await freshPi.emitContext(history, resumedCtx);
		const projectedPage = projected.find((message) => message.role === "toolResult" && message.toolCallId === page.toolCallId)!;
		expect(resultText(projectedPage)).toContain(`retrieve: call obs_recall with {"id":"${id}","offset":128}`);
		expect(projectedPage).toMatchObject({ details: page.details, isError: false });
		expect(resultText(await recallPage(freshPi, id, 128, resumedCtx))).toBe(resultText(page));
		expect(await readFile(sessionFile, "utf8")).toBe(persisted);

		// A compacted fork has a different object root and no source in context.
		// Do not erase its retained page or silently reach into the parent session.
		resumed.createBranchedSession(resumed.getLeafId()!);
		expect(resumed.getSessionId()).not.toBe(manager.getSessionId());
		const errors = captureConsoleErrors();
		const forked = await observationPackPi().emitContext(resumed.buildSessionContext().messages, resumedCtx);
		const forkedPage = forked.find((message) => message.role === "toolResult" && message.toolCallId === page.toolCallId)!;
		expect(resultText(forkedPage)).toBe(resultText(page));
		expect(errors).toHaveLength(1);

		// Returning to a branch with the source lets the existing pack path
		// reconstruct it under the fork's own root before projecting the page.
		resumed.branch(beforeCompaction);
		const withSource = await observationPackPi().emitContext(resumed.buildSessionContext().messages, resumedCtx);
		const rebuiltPage = withSource.find((message) => message.role === "toolResult" && message.toolCallId === page.toolCallId)!;
		expect(resultText(rebuiltPage)).toBe(resultText(projectedPage));
		expect(errors).toHaveLength(1);
		expect(await readdir(join(sessionDir, "sol-pi", resumed.getSessionId(), "observation-pack", "objects"))).toEqual([`${id}.txt`]);
	});

	it.each(["missing", "changed", "symlink"])("keeps a recall page intact when its source is %s", async (mode) => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const original = toolResult("x".repeat(40_000));
		const id = observationId(original);
		await project(pi, original, sessionDir, 3);
		const page = await recallPage(pi, id, 0, fakeContext(sessionDir));
		const path = observationPath(sessionDir, id);
		if (mode === "changed") await writeFile(path, "y".repeat(40_000));
		else {
			await rm(path);
			if (mode === "symlink") {
				const target = join(sessionDir, "external.txt");
				await writeFile(target, "x".repeat(40_000));
				await symlink(target, path);
			}
		}
		const errors = captureConsoleErrors();
		const text = resultText(page);
		expect(await project(pi, page, sessionDir, 3)).toEqual([text, text, text]);
		expect(errors).toHaveLength(1);
		expect(await readdir(observationObjectsDirectory(sessionDir))).not.toContain(`${observationId(page)}.txt`);
	});

	it("does not derive recall authority from page text or invalid details", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const original = toolResult("x".repeat(40_000));
		const id = observationId(original);
		await project(pi, original, sessionDir, 3);
		const page = await recallPage(pi, id, 0, fakeContext(sessionDir));
		const text = resultText(page);
		const errors = captureConsoleErrors();
		for (const details of [undefined, {}, { ...page.details, id: "../../outside" }, { ...page.details, offset: -1 },
			{ ...page.details, offset: 0.5 }, { ...page.details, nextOffset: -1 }, { ...page.details, eof: "false" }]) {
			expect(await project(pi, { ...page, details }, sessionDir, 3)).toEqual([text, text, text]);
		}
		expect(errors).toEqual([]);
		// Well-shaped but inconsistent metadata is also not enough to discard text.
		for (const details of [{ ...page.details, nextOffset: page.details.nextOffset + 1 }, { ...page.details, eof: true }]) {
			expect(await project(pi, { ...page, details }, sessionDir, 3)).toEqual([text, text, text]);
		}
		expect(errors.length).toBeGreaterThan(0);
		expect(await project(pi, { ...page, isError: true }, sessionDir, 3)).toEqual([text, text, text]);
		expect(await readdir(observationObjectsDirectory(sessionDir))).toEqual([`${id}.txt`]);
		const ordinary = { ...page, toolName: "bash", toolCallId: "not-recall" };
		expect((await project(pi, ordinary, sessionDir, 3))[2]).toContain(`id: ${observationId(ordinary)}`);
	});

	it("fails storage closed when a same-size object holds different content", async () => {
		const sessionDir = await sessionRoot();
		const body = `expected\n${repeatPastThreshold("original bytes\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		await mkdir(observationObjectsDirectory(sessionDir), { recursive: true });
		await writeFile(observationPath(sessionDir, id), "x".repeat(Buffer.byteLength(body, "utf8")));
		const errors = captureConsoleErrors();

		expect(await project(observationPackPi(), message, sessionDir, 3)).toEqual([body, body, body]);
		expect(errors.some((error) => error.includes(id) && error.includes("hash mismatch"))).toBe(true);
	});

	it("accepts an existing same-content object as idempotent storage", async () => {
		const sessionDir = await sessionRoot();
		const body = `idempotent\n${repeatPastThreshold("same bytes\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		await mkdir(observationObjectsDirectory(sessionDir), { recursive: true });
		await writeFile(observationPath(sessionDir, id), body);

		const projected = await project(observationPackPi(), message, sessionDir, 3);

		expect(projected[0]).toBe(body);
		expect(projected[1]).toBe(body);
		expect(projected[2]).toMatch(new RegExp(`id: ${id}`, "u"));
	});

	it("fails recall closed when an object path is replaced by a symlink", async () => {
		const sessionDir = await sessionRoot();
		const body = `stored\n${repeatPastThreshold("observation bytes\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const path = observationPath(sessionDir, id);
		const target = join(sessionDir, "symlink-target.txt");
		await writeFile(target, "target bytes must not be recalled");
		await rm(path);
		await symlink(target, path);

		await expect(
			pi.tool("obs_recall").execute("recall-1", { id, offset: 0 }, undefined, undefined, fakeContext(sessionDir)),
		).rejects.toMatchObject({ code: "ELOOP" });
	});

	it("returns the exact original bytes across paged recall", async () => {
		const sessionDir = await sessionRoot();
		const body = `utf8: luna ☾\n${"0123456789abcdef\n".repeat(1_200)}final line`;
		const message = toolResult(body);
		const id = observationId(message);
		const pi = observationPackPi();
		await project(pi, message, sessionDir, 3);
		const recall = pi.tool("obs_recall");

		let offset = 0;
		let recalled = "";
		for (;;) {
			const result = await recall.execute("recall-1", { id, offset }, undefined, undefined, fakeContext(sessionDir));
			const details = result.details as { eof: boolean; nextOffset: number };
			const output = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			const firstNewline = output.indexOf("\n");
			const secondNewline = output.indexOf("\n", firstNewline + 1);
			expect(secondNewline).not.toBe(-1);
			recalled += output.slice(secondNewline + 1);
			offset = details.nextOffset;
			if (details.eof) break;
		}

		expect(recalled).toBe(body);
		expect(Buffer.from(recalled, "utf8")).toEqual(Buffer.from(body, "utf8"));
	});

	it("fails storage closed when the observation directory is a symlink", async () => {
		const sessionDir = await sessionRoot();
		const targetDir = await sessionRoot();
		await mkdir(join(sessionDir, "sol-pi", SESSION_ID, "observation-pack"), { recursive: true });
		await symlink(targetDir, observationObjectsDirectory(sessionDir), "dir");
		const body = `directory guard\n${repeatPastThreshold("must not escape\n")}`;
		const message = toolResult(body);
		const id = observationId(message);
		const errors = captureConsoleErrors();

		expect(await project(observationPackPi(), message, sessionDir, 3)).toEqual([body, body, body]);
		expect(errors.some((error) => error.includes(id) && error.includes("not a regular directory"))).toBe(true);
		await expect(readFile(join(targetDir, `${id}.txt`))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps the mutation confirmation and then_run marker of a fused write", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const message = toolResult("", {
			toolCallId: "write-1",
			toolName: "write",
			content: [
				{ type: "text", text: "Successfully wrote 12 bytes to target.ts" },
				{ type: "text", text: `[then_run:succeeded]\n${"builder output\n".repeat(400)}` },
			],
			details: { patch: "preserved" },
		});

		let projected: AgentMessage[] = [];
		for (let request = 0; request < 3; request += 1) {
			projected = await pi.emitContext([message], fakeContext(sessionDir));
		}

		const result = projected[0];
		expect(result?.role).toBe("toolResult");
		expect(resultText(result!)).toMatch(/Successfully wrote 12 bytes to target\.ts/u);
		expect(resultText(result!)).toMatch(/\[then_run:succeeded\]/u);
		expect(result).toMatchObject({ details: { patch: "preserved" }, isError: false });
	});

	it("passes through errors, mixed content, and reducer receipts", async () => {
		const sessionDir = await sessionRoot();
		const large = "x".repeat(THRESHOLD_BYTES + 100);
		const error = toolResult(large, { isError: true });
		const mixed = toolResult(large, {
			content: [
				{ type: "text", text: large },
				{ type: "image", data: "AA==", mimeType: "image/png" },
			],
		});
		const receipt = toolResult(`sol_pi_evidence_receipt_v1\n${large}`);
		const compoundReceipt = toolResult("", {
			toolName: "write",
			content: [
				{ type: "text", text: "Successfully wrote 12 bytes to target.ts" },
				{ type: "text", text: `[then_run:succeeded]\nsol_pi_evidence_receipt_v1\n${large}` },
			],
		});

		expect(await project(observationPackPi(), error, sessionDir, 3)).toEqual([large, large, large]);
		expect(await project(observationPackPi(), mixed, sessionDir, 3)).toEqual([large, large, large]);
		const receiptText = resultText(receipt);
		expect(await project(observationPackPi(), receipt, sessionDir, 3)).toEqual([receiptText, receiptText, receiptText]);
		const compoundText = resultText(compoundReceipt);
		expect(await project(observationPackPi(), compoundReceipt, sessionDir, 3)).toEqual([
			compoundText,
			compoundText,
			compoundText,
		]);
	});
});
