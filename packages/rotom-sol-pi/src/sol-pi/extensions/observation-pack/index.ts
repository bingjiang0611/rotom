/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * ObservationPack - keep large tool results reachable without replaying them.
 *
 * A large tool result is sent in full for its first few provider requests, then
 * replaced with a short, stable placeholder for every later request. The
 * original bytes are archived by observation id outside the provider context,
 * and the agent pulls exact pages back with the registered `obs_recall` tool.
 *
 * The mechanism never edits history in place. It rewrites only at the
 * projection layer (`pi.on("context")`), so the stored session stays intact and
 * recall keeps working after native compaction or a session resume.
 *
 * Storage lives under the active Pi session directory.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runtimeRoot } from "../../runtime-paths.ts";
import { formatSavingsCount, renderSolPiTool, showSolPiSavings } from "../../tui.ts";
import { createLedger, type Ledger } from "./ledger.ts";
import {
	countLines,
	createObservation,
	ensureStored,
	estimateTokens,
	FULL_SENDS,
	isObservationId,
	isPureTextResult,
	observationPath,
	placeholderFor,
	type RecallChunk,
	readRecallChunk,
} from "./observation.ts";

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;

const RECALL_LIMITS = {
	maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
	maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

type RecallReference = { id: string; offset: number; nextOffset: number; eof: boolean };

function recallReference(details: unknown): RecallReference | undefined {
	if (!details || typeof details !== "object") return undefined;
	const { id, offset, nextOffset, eof } = details as Partial<RecallReference>;
	if (
		typeof id !== "string" || !isObservationId(id) ||
		typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
		typeof nextOffset !== "number" || !Number.isSafeInteger(nextOffset) || nextOffset < offset ||
		typeof eof !== "boolean"
	) return undefined;
	return { id, offset, nextOffset, eof };
}

function recallText(id: string, offset: number, chunk: RecallChunk): string {
	return [
		`[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
		`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
		chunk.text,
	].join("\n");
}

async function recallPlaceholder(root: string, source: RecallReference, text: string): Promise<string> {
	// Details identify the source, not proof that it is still reachable. Compare
	// this bounded page before replacing any evidence; missing/changed storage
	// (including a fork without the source) must leave the original result intact.
	const chunk = await readRecallChunk(observationPath(root, source.id), source.offset, RECALL_LIMITS);
	if (
		chunk.nextOffset !== source.nextOffset || chunk.eof !== source.eof ||
		recallText(source.id, source.offset, chunk) !== text
	) throw new Error("Stored recall page does not match the original result");
	return [
		`[recalled page replaced after its first ${FULL_SENDS} provider requests]`,
		`id: ${source.id}`,
		`tool: obs_recall`,
		`offset: ${source.offset}`,
		`next_offset: ${source.nextOffset}`,
		`eof: ${source.eof}`,
		`retrieve: call obs_recall with ${JSON.stringify({ id: source.id, offset: source.offset })} to re-read this page`,
		source.eof
			? "[this page reaches source EOF; it does not prove earlier pages were read]"
			: `continue: call obs_recall with ${JSON.stringify({ id: source.id, offset: source.nextOffset })}`,
	].join("\n");
}

export function createObservationPackExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const sentCounts = new Map<string, number>();
		const ledgers = new Map<string, Ledger>();
		const ledgerFor = (ctx: ExtensionContext): Ledger => {
			const root = runtimeRoot(ctx);
			let ledger = ledgers.get(root);
			if (!ledger) {
				ledger = createLedger(join(root, "observation-pack", "ledger.jsonl"));
				ledgers.set(root, ledger);
			}
			return ledger;
		};

		pi.registerTool({
			name: "obs_recall",
			label: "Recall Observation",
			description: "Read a stored large tool result by observation id and byte offset.",
			promptSnippet: "Recall a paged excerpt from a previously replaced large tool result",
			renderShell: "self",
			parameters: Type.Object({
				id: Type.String({ description: "Observation id from a placeholder" }),
				offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, default 0" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!isObservationId(params.id)) throw new Error(`Unknown observation id: ${params.id}`);
				const offset = params.offset ?? 0;
				let chunk: RecallChunk;
				try {
					chunk = await readRecallChunk(observationPath(runtimeRoot(ctx), params.id), offset, RECALL_LIMITS);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") {
						throw new Error(`Unknown observation id: ${params.id}`);
					}
					throw error;
				}
				const content = recallText(params.id, offset, chunk);
				if (Buffer.byteLength(content, "utf8") > RECALL_MAX_BYTES || countLines(content) > RECALL_MAX_LINES) {
					throw new Error("Recall output exceeded its hard limit");
				}
				await ledgerFor(ctx)({
					event: "recall",
					id: params.id,
					offset,
					bytes: chunk.bytes,
					lines: chunk.lines,
					nextOffset: chunk.nextOffset,
					eof: chunk.eof,
				});
				return {
					content: [{ type: "text", text: content }],
					details: {
						id: params.id,
						offset,
						bytes: chunk.bytes,
						lines: chunk.lines,
						nextOffset: chunk.nextOffset,
						eof: chunk.eof,
					},
				};
			},
			renderCall(params, theme) {
				const offset = params.offset ?? 0;
				const base = new Text(theme.fg("dim", `Recall ${params.id} from byte ${offset}`), 0, 0);
				return renderSolPiTool(theme, "Observation Pack", "full observation replay avoided", base);
			},
			renderResult(result, { isPartial }, theme) {
				const details = result.details as { bytes?: number; lines?: number } | undefined;
				const base = new Text(
					theme.fg(
						isPartial ? "warning" : "dim",
						isPartial
							? "Recalling the requested slice..."
							: `Recalled ${details?.bytes ?? 0} bytes across ${details?.lines ?? 0} lines`,
					),
					0,
					0,
				);
				return renderSolPiTool(theme, "Observation Pack", "full observation replay avoided", base);
			},
		});

		pi.on("context", async (event, ctx: ExtensionContext) => {
			const projected = [...event.messages];
			const root = runtimeRoot(ctx);
			// How many provider requests each message has already been part of,
			// counted by the assistant messages that follow it.
			const priorAssistantCounts = new Array<number>(event.messages.length);
			let assistantCount = 0;

			for (let index = event.messages.length - 1; index >= 0; index -= 1) {
				priorAssistantCounts[index] = assistantCount;
				if (event.messages[index]?.role === "assistant") assistantCount += 1;
			}

			const requestIndex = assistantCount + 1;
			for (let index = 0; index < event.messages.length; index += 1) {
				const message = event.messages[index];
				if (!message || !isPureTextResult(message)) continue;

				try {
					const observation = createObservation(message, root);
					if (!observation) continue;
					const recall = message.toolName === "obs_recall" ? recallReference(message.details) : undefined;
					if (message.toolName === "obs_recall" && !recall) continue;
					// Recall results already refer to archived bytes. Their derived id is
					// only a send-counter key, never another object or ledger source id.
					if (!recall) await ensureStored(observation);
					const source = recall ?? { id: observation.id };

					const sendCountKey = `${root}\0${observation.id}`;
					const previousSends = sentCounts.get(sendCountKey) ?? priorAssistantCounts[index] ?? 0;
					if (previousSends < FULL_SENDS) {
						await ledgerFor(ctx)({
							event: "full",
							...source,
							request: requestIndex,
							tool: observation.toolName,
							originalBytes: observation.bytes,
							originalLines: observation.lines,
							originalTokens: observation.tokens,
							contentHash: observation.contentHash,
						});
						sentCounts.set(sendCountKey, previousSends + 1);
						continue;
					}

					const placeholder = recall
						? await recallPlaceholder(root, recall, observation.text)
						: placeholderFor(observation);
					const placeholderTokens = estimateTokens(placeholder);
					const removedTokens = Math.max(0, observation.tokens - placeholderTokens);
					await ledgerFor(ctx)({
						event: "placeholder",
						...source,
						request: requestIndex,
						sendNumber: previousSends + 1,
						tool: observation.toolName,
						originalBytes: observation.bytes,
						originalLines: observation.lines,
						originalTokens: observation.tokens,
						placeholderBytes: Buffer.byteLength(placeholder, "utf8"),
						placeholderTokens,
						removedTokens,
					});
					if (previousSends === FULL_SENDS) {
						showSolPiSavings(
							ctx,
							"Observation Pack",
							formatSavingsCount(removedTokens, "context tokens avoided"),
						);
					}
					projected[index] = { ...message, content: [{ type: "text", text: placeholder }] };
					sentCounts.set(sendCountKey, previousSends + 1);
				} catch (error) {
					// Fail open: a packing failure must never cost the agent its observation.
					const reason = error instanceof Error ? error.message : String(error);
					console.error(`[observationpack] fail-open for tool result: ${reason}`);
				}
			}

			return { messages: projected };
		});
	};
}

export {
	createObservation,
	FULL_SENDS,
	type Observation,
	PLACEHOLDER_EXCERPT_BYTES,
	placeholderFor,
	THRESHOLD_BYTES,
} from "./observation.ts";

export function registerObservationPack(pi: ExtensionAPI): void {
	createObservationPackExtension()(pi);
}

export default registerObservationPack;
