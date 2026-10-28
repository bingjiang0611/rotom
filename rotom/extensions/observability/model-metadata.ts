import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundedTag, finiteNumber, type TraceAttributes, type TraceStatus } from "./trace-schema.ts";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

// Bounded category of a failed provider request. Patterns match error texts seen
// in real rotom sessions; only the label (and an HTTP status parsed from a
// leading status code) is recorded, never the text. Anything else stays
// "unknown" rather than being guessed.
const PROVIDER_ERROR_CATEGORIES: ReadonlyArray<readonly [category: string, pattern: RegExp]> = [
	["timeout", /timed out|\btimeout\b/iu],
	["websocket", /^WebSocket (?:error|closed)\b/u],
	["aborted", /^This operation was aborted$/u],
	["overloaded", /overloaded/iu],
	["network", /^(?:fetch failed|terminated|Connection error\.)(?: \(caused by: .*\))?$|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|socket hang up|^upstream connect error/u],
	["auth", /^API key auth failed\b/u],
	["provider_error", /^Codex error:|^\{"type":"error"/u],
];
const LEADING_HTTP_STATUS = /^([45]\d\d)\b/u;
// Compaction failures wrap the provider error: "Compaction failed: Summarization failed: <error>".
const SUMMARY_FAILURE_PREFIX = /^Compaction failed: (?:[A-Za-z ]+ failed: )?/u;

export function providerErrorAttributes(errorMessage: unknown, httpStatus: number | undefined): TraceAttributes {
	const text = typeof errorMessage === "string" ? errorMessage.replace(SUMMARY_FAILURE_PREFIX, "").trim() : "";
	const status = Number(LEADING_HTTP_STATUS.exec(text)?.[1]) || (httpStatus !== undefined && httpStatus >= 400 ? httpStatus : undefined);
	if (status) return { "pi.ai.error.category": "http", "pi.ai.error.http_status": status };
	return { "pi.ai.error.category": PROVIDER_ERROR_CATEGORIES.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown" };
}

/** Launcher-owned, identity-gated versions. Direct SDK or `-e` loads lack them and leave them absent. */
export function runtimeVersionAttributes(env: NodeJS.ProcessEnv = process.env): TraceAttributes {
	const product = env.ROTOM_PRODUCT_VERSION;
	const pi = env.ROTOM_VERIFIED_PI_VERSION;
	return {
		...(product && EXACT_VERSION.test(product) ? { "rotom.product.version": product } : {}),
		...(pi && EXACT_VERSION.test(pi) ? { "pi.runtime.version": pi } : {}),
	};
}

/** Per-request timing of a built-in compaction, keyed by summary kind. */
export function summaryCallAttributes(value: unknown): TraceAttributes {
	if (!Array.isArray(value)) return {};
	const attributes: TraceAttributes = {};
	for (const call of value.slice(0, 2)) {
		const kind = call?.kind === "history" || call?.kind === "turn_prefix" ? call.kind : undefined;
		if (!kind) continue;
		for (const [field, name] of [["durationMs", "ms"], ["attempts", "attempts"], ["firstThinkingMs", "first_thinking_ms"], ["firstTextMs", "first_text_ms"]] as const) {
			const number = finiteNumber(call[field]);
			if (number !== undefined) attributes[`pi.compaction.${kind}.${name}`] = number;
		}
	}
	return attributes;
}

export function usageAttributes(value: unknown): TraceAttributes {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const usage = value as Record<string, unknown>;
	const cost = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
		? finiteNumber((usage.cost as Record<string, unknown>).total)
		: undefined;
	return Object.fromEntries([
		["pi.usage.input_tokens", finiteNumber(usage.input)],
		["pi.usage.output_tokens", finiteNumber(usage.output)],
		["pi.usage.cache_read_tokens", finiteNumber(usage.cacheRead)],
		["pi.usage.cache_write_tokens", finiteNumber(usage.cacheWrite)],
		["pi.usage.reasoning_tokens", finiteNumber(usage.reasoning)],
		["pi.usage.total_tokens", finiteNumber(usage.totalTokens)],
		["pi.usage.cost", cost],
	].filter((entry): entry is [string, number] => entry[1] !== undefined));
}

export function statusFromAssistant(message: any): TraceStatus {
	if (message?.stopReason === "error") return "error";
	if (message?.stopReason === "aborted") return "aborted";
	return "ok";
}

export function assistantAttributes(message: any): TraceAttributes {
	if (!message || message.role !== "assistant") return {};
	return {
		...(boundedTag(message.provider, 128) ? { "pi.ai.provider": boundedTag(message.provider, 128)! } : {}),
		...(boundedTag(message.model) ? { "pi.ai.model": boundedTag(message.model)! } : {}),
		...(boundedTag(message.api, 128) ? { "pi.ai.api": boundedTag(message.api, 128)! } : {}),
		...(boundedTag(message.stopReason, 64) ? { "pi.ai.response.stop_reason": boundedTag(message.stopReason, 64)! } : {}),
		...usageAttributes(message.usage),
	};
}

export function modelAttributes(ctx: ExtensionContext): TraceAttributes {
	const model = ctx.model as any;
	return {
		...(boundedTag(model?.provider, 128) ? { "pi.ai.provider": boundedTag(model.provider, 128)! } : {}),
		...(boundedTag(model?.id) ? { "pi.ai.model": boundedTag(model.id)! } : {}),
		...(boundedTag(model?.api, 128) ? { "pi.ai.api": boundedTag(model.api, 128)! } : {}),
		...(finiteNumber(model?.contextWindow) !== undefined ? { "pi.ai.context_window": finiteNumber(model.contextWindow)! } : {}),
		...(boundedTag(ctx.thinkingLevel, 32) ? { "pi.ai.thinking_level": boundedTag(ctx.thinkingLevel, 32)! } : {}),
	};
}

export function contextUsageAttributes(ctx: ExtensionContext): TraceAttributes {
	if (typeof ctx.getContextUsage !== "function") return {};
	const usage = ctx.getContextUsage();
	if (!usage) return {};
	return {
		...(finiteNumber(usage.tokens) !== undefined ? { "pi.context.tokens": finiteNumber(usage.tokens)! } : {}),
		...(finiteNumber(usage.contextWindow) !== undefined ? { "pi.context.window_tokens": finiteNumber(usage.contextWindow)! } : {}),
		...(finiteNumber(usage.percent) !== undefined ? { "pi.context.percent": finiteNumber(usage.percent)! } : {}),
	};
}

/** Public tool metadata only: not provider wire schemas, prompt tokens or cache-hit evidence. */
