import { createHash } from "node:crypto";
import type { ActiveGoal } from "./persistence.js";

export interface ToolFreeRepeatState {
	toolFreeRepeatCount: number;
	lastToolFreeOutputFingerprint?: string;
}

export function queueGoalSafetyReset(goal: ActiveGoal): ActiveGoal {
	return { ...goal, safetyResetPending: true };
}

export function resetGoalSafetyEpoch(goal: ActiveGoal): ActiveGoal {
	return {
		...goal,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
		lastToolFreeOutputFingerprint: undefined,
		safetyPauseCause: undefined,
		safetyResetPending: undefined,
	};
}

// rotom fork enhancement (see UPSTREAM.md, "no-progress"):
//
// Upstream only counts a no-progress repeat when a run makes NO tool call, and
// resets the counter whenever any tool is attempted. That lets an agent loop
// forever by re-issuing the exact same failing tool call: each attempt resets
// the guard, so only the hard automatic-response cap can stop it.
//
// This fork counts a repeat when the run's *observable behaviour* is identical
// to the previous automatic run — the same visible assistant text AND the same
// tool-call signature (tool names + normalized arguments). Any genuine progress
// (different arguments, different text, or switching between tool and tool-free
// output) produces a different fingerprint and resets the counter to one, so
// this never charges productive iterative work. When a run makes no tool call
// the tool-call signature is empty and the fingerprint reduces to the exact
// upstream tool-free text fingerprint, preserving prior behaviour and persisted
// counters. Tripping this guard only PAUSES the goal (recoverable via
// `/goal resume`); it never blocks or auto-retries a write.
export function nextToolFreeRepeatState(
	current: ToolFreeRepeatState,
	messages: readonly unknown[],
	toolAttempted: boolean,
): ToolFreeRepeatState {
	const fingerprint = fingerprintAutomaticRunProgress(messages, toolAttempted);
	return {
		toolFreeRepeatCount:
			fingerprint === current.lastToolFreeOutputFingerprint
				? Math.min(Number.MAX_SAFE_INTEGER, current.toolFreeRepeatCount + 1)
				: 1,
		lastToolFreeOutputFingerprint: fingerprint,
	};
}

export function hasAssistantToolCall(messages: readonly unknown[]) {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		if (message.content.some((block) => isRecord(block) && block.type === "toolCall")) return true;
	}
	return false;
}

// Combined progress fingerprint: visible assistant text plus the ordered list of
// tool-call signatures issued in the run. `toolAttempted` is honoured so a run
// that Pi reports as tool-attempting but whose tool blocks are not visible in
// `messages` still contributes a stable, non-empty tool marker rather than
// collapsing to a pure tool-free fingerprint.
export function fingerprintAutomaticRunProgress(
	messages: readonly unknown[],
	toolAttempted: boolean,
) {
	const text = normalizeVisibleAssistantOutput(messages);
	const signature = toolCallSignature(messages);
	const toolMarker = signature === "" && toolAttempted ? "tool:opaque" : signature;
	// No tool marker => byte-identical to the upstream tool-free fingerprint, so a
	// mid-session upgrade keeps matching persisted fingerprints instead of
	// resetting the counter. A tool marker folds in only when one exists.
	if (toolMarker === "") return createHash("sha256").update(text, "utf8").digest("hex");
	return createHash("sha256").update(`${text}\u0000${toolMarker}`, "utf8").digest("hex");
}

export function fingerprintVisibleAssistantOutput(messages: readonly unknown[]) {
	const normalized = normalizeVisibleAssistantOutput(messages);
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// Ordered signature of the assistant tool calls in a run: `name(argsJson)` with
// stably-sorted argument keys. Argument fields are read defensively because the
// exact block shape (arguments/args/input/parameters) is not part of the goal
// contract; unknown shapes fall back to the tool name alone, which still lets
// identical repeated calls match while never throwing on an unexpected block.
export function toolCallSignature(messages: readonly unknown[]) {
	const parts: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "toolCall") continue;
			const name =
				(typeof block.name === "string" && block.name) ||
				(typeof block.toolName === "string" && block.toolName) ||
				"tool";
			const args =
				block.arguments ?? block.args ?? block.input ?? block.parameters ?? null;
			parts.push(`${name}(${stableStringify(args)})`);
		}
	}
	return parts.join("\u0001");
}

function stableStringify(value: unknown): string {
	try {
		return JSON.stringify(value, (_key, inner) => {
			if (isRecord(inner)) {
				const sorted: Record<string, unknown> = {};
				for (const key of Object.keys(inner).sort()) sorted[key] = inner[key];
				return sorted;
			}
			return inner;
		}) ?? "null";
	} catch {
		return "unserializable";
	}
}

export function normalizeVisibleAssistantOutput(messages: readonly unknown[]) {
	const text: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
			text.push(block.text);
		}
	}
	const normalized = text
		.join("\n")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	return normalized === "" || /^[\p{P}\s]+$/u.test(normalized) ? "" : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
