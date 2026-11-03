/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { expect, vi } from "vitest";
import { createObservationPackExtension, THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/index.ts";
import type { RecallChunk } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { FakePi, fakeContext, type ToolContext } from "./helpers.ts";

export const roots: string[] = [];
export const SESSION_ID = "session-a";

export async function sessionRoot(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "observationpack-test-"));
	roots.push(value);
	return value;
}

export function observationPackPi(): FakePi {
	const pi = new FakePi();
	createObservationPackExtension()(pi.asExtensionApi());
	return pi;
}

export function repeatPastThreshold(line: string): string {
	return line.repeat(Math.ceil((THRESHOLD_BYTES + 1) / Buffer.byteLength(line, "utf8")));
}

export function toolResult(text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
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

export function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") throw new Error("expected tool result");
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export function observationId(message: ToolResultMessage): string {
	const contentHash = createHash("sha256").update(resultText(message)).digest("hex");
	const identity = `${message.toolName}\0${message.toolCallId}\0${contentHash}`;
	return `obs_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function observationPath(sessionDir: string, id: string): string {
	return join(sessionDir, "sol-pi", SESSION_ID, "observation-pack", "objects", `${id}.txt`);
}

export function observationObjectsDirectory(sessionDir: string): string {
	return join(sessionDir, "sol-pi", SESSION_ID, "observation-pack", "objects");
}

export async function project(pi: FakePi, message: ToolResultMessage, sessionDir: string, count: number): Promise<string[]> {
	const projected: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const messages = await pi.emitContext([message], fakeContext(sessionDir));
		const result = messages[0];
		if (!result) throw new Error("missing projection");
		projected.push(resultText(result));
	}
	return projected;
}

export async function recallPage(
	pi: FakePi, id: string, offset: number, ctx: ToolContext, toolCallId = "recall-1",
): Promise<Omit<ToolResultMessage, "details"> & { details: Pick<RecallChunk, "nextOffset" | "eof"> }> {
	const result = await pi.tool("obs_recall").execute(toolCallId, { id, offset }, undefined, undefined, ctx);
	expect(result).not.toHaveProperty("isError", true);
	expect(result.details).toEqual(expect.objectContaining({ nextOffset: expect.any(Number), eof: expect.any(Boolean) }));
	const details = result.details as Pick<RecallChunk, "nextOffset" | "eof">;
	return { ...toolResult("", { ...result, details, toolName: "obs_recall", toolCallId }), details };
}

export function captureConsoleErrors(): string[] {
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
		errors.push(values.map(String).join(" "));
	});
	return errors;
}
