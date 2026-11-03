/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FULL_SENDS, THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";
import { fakeContext } from "./helpers.ts";
import {
	captureConsoleErrors, observationId, observationObjectsDirectory, observationPackPi,
	observationPath, project, recallPage, repeatPastThreshold, resultText, roots, SESSION_ID,
	sessionRoot, toolResult,
} from "./observation-pack-fixture.ts";

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

describe("observation recall", () => {
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
				expect(placeholder).toContain("next_offset: null");
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

	it.each([1, 4])("terminates text-only next_offset pagination for a %i-page observation", async (pages) => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const body = "中文🙂 recall bytes".repeat(600 * pages);
		const message = toolResult(body);
		const id = observationId(message);
		await project(pi, message, sessionDir, 3);
		let offset: number | null = 0;
		let recalled = "";
		let calls = 0;

		// Reproduce the real Codemode consumer: only the rendered text is available,
		// and a numeric next_offset means another request. Bound the test, not the API.
		while (offset !== null && calls < 10) {
			const page = await recallPage(pi, id, offset, fakeContext(sessionDir));
			const output = resultText(page);
			const next = output.match(/next_offset=(\d+)/u);
			offset = next ? Number(next[1]) : null;
			recalled += output.slice(output.indexOf("\n", output.indexOf("\n") + 1) + 1);
			calls++;
		}

		expect(offset).toBeNull();
		expect(calls).toBe(pages);
		expect(Buffer.from(recalled)).toEqual(Buffer.from(body));
	});

	it("marks reads at EOF as terminal and still rejects offsets beyond EOF", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const body = repeatPastThreshold("terminal bytes\n");
		const message = toolResult(body);
		const id = observationId(message);
		await project(pi, message, sessionDir, 3);
		await expect(pi.tool("obs_recall").execute(
			"beyond-eof", { id, offset: Buffer.byteLength(body) + 1 }, undefined, undefined, fakeContext(sessionDir),
		)).rejects.toThrow("exceeds observation size");
		const page = await recallPage(pi, id, Buffer.byteLength(body), fakeContext(sessionDir));

		expect(resultText(page)).toContain("next_offset=null eof=true]");
		expect(resultText(page)).toContain("stop paging");
		expect(resultText(page)).not.toContain("use next_offset to continue");
		// Persisted metadata retains its numeric byte boundary for source validation.
		expect(page.details).toMatchObject({ nextOffset: Buffer.byteLength(body), eof: true });
	});

	it("keeps legacy EOF page text intact rather than rewriting persisted evidence", async () => {
		const sessionDir = await sessionRoot();
		const pi = observationPackPi();
		const body = "x".repeat(12_000);
		const message = toolResult(body);
		const id = observationId(message);
		await project(pi, message, sessionDir, 3);
		const page = await recallPage(pi, id, 0, fakeContext(sessionDir));
		const legacyText = `[obs_recall id=${id} offset=0 next_offset=12000 eof=true]\n[chunk_bytes=12000 chunk_lines=1; use next_offset to continue]\n${body}`;
		const legacyPage = { ...page, content: [{ type: "text" as const, text: legacyText }] };
		captureConsoleErrors();

		expect(await project(pi, legacyPage, sessionDir, 3)).toEqual([legacyText, legacyText, legacyText]);
		expect(resultText(await recallPage(pi, id, 0, fakeContext(sessionDir)))).toContain("next_offset=null eof=true]");
	});

});
