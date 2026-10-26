import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PiCodingAgentHarnessOptions } from "./pi-harness.ts";
import { REPLAY_CONFIG, type ReplayTask } from "./compaction-offload-cases.ts";

export const FAUX_MODEL = { provider: "rotom-offload-faux", id: "replay" };
export type FauxObservation = {
	requests: { system: string; tools: string; summary: boolean; maxTokens: number | null; reads: number; phase1: boolean }[];
	config: unknown; agentDirMatches: boolean; summaryCalls: number; workspace?: string;
	settings?: { compaction: { reserveTokens: number; keepRecentTokens?: number }; retry: { enabled: boolean } };
	reasoning?: string;
	requestControls?: { transport?: string; maxRetries?: number }[];
};
/** Only scripted local responses. No credentials, network provider, or generated judgment. */
export function replayFaux(selected: ReplayTask, observation: FauxObservation, stress = false, profile = { model: FAUX_MODEL, contextWindow: 256_000, reasoning: false }, script: { batchSize?: number; phase1ReadLimit?: number; pressure?: "no_candidates" | "insufficient_savings" } = {}): NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]> {
	return async ({ product, configDir }) => {
		const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(resolve(product.verified.packageRoot, "../pi-ai/dist/providers/faux.js")).href);
		const { getCurrentSystemPrompt, getCurrentTools } = await import(pathToFileURL(resolve(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
		const faux = fauxProvider({ provider: profile.model.provider, models: [{ id: profile.model.id, contextWindow: profile.contextWindow, maxTokens: 4096, reasoning: profile.reasoning }] });
		observation.config = JSON.parse(await readFile(join(configDir, "sol-pi.json"), "utf8"));
		observation.agentDirMatches = product.runtime.getAgentDir() === configDir;
		observation.workspace = resolve(configDir, "../workspace");
		if (JSON.stringify(observation.config) !== JSON.stringify(REPLAY_CONFIG) || !observation.agentDirMatches) throw new Error("SoL-Pi configuration is not bound to the isolated agent directory");
		if (stress) await writeFile(resolve(configDir, "../workspace/ordinary.txt"), "ordinary synthetic data\n".repeat(600));
		const normalize = (text: string) => text.split(resolve(configDir, "..")).join("<run>");
		let readIndex = 0, manifestRead = false, ready = false, recalled = false;
		let detailChecked = false;
		let solutionIndex = 0, ordinaryRead = false, ordinaryRecall = false, inflated = false;
		let callId = 0, ordinaryWait = 0, pressureSent = false;
		const readCallIds = new Map<string, string>();
		const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args, { id: `scripted-${++callId}` }), { stopReason: "toolUse" });
		const response = (context: any, options: any) => {
			observation.settings ??= JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
			observation.reasoning = options.reasoning;
			(observation.requestControls ??= []).push({ transport: options.transport, maxRetries: options.maxRetries });
			// Fix faux accounting to uncached input; this is not a cache-price prediction.
			options.cacheRetention = "none";
			const systems = context.messages.filter((m: any) => m.role === "system");
			const text = (m: any) => typeof m.content === "string" ? m.content : m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
			const summary = systems.some((m: any) => text(m).includes("context summarization assistant"));
			observation.requests.push({ system: normalize(getCurrentSystemPrompt(context.messages)), tools: normalize(JSON.stringify(getCurrentTools(context.messages))), summary, maxTokens: options.maxTokens ?? null, reads: readIndex, phase1: !ready });
			if (summary) {
				observation.summaryCalls++;
				return fauxAssistantMessage("## Goal\nFinish the synthetic audit.\n## Progress\nRead files and continue the requested follow-up.\n## Next steps\nUse the workspace to finish and validate.");
			}
			if (script.pressure && !pressureSent && (script.pressure === "no_candidates" || readIndex >= 3)) {
				pressureSent = true;
				return fauxAssistantMessage([
					{ type: "text", text: "unoffloadable synthetic explanation\n".repeat(10_000) },
					fauxToolCall("read", { path: "manifest.json" }, { id: `scripted-${++callId}` }),
				], { stopReason: "toolUse" });
			}
			if (!manifestRead) { manifestRead = true; return call("read", { path: "manifest.json" }); }
			const readLimit = script.phase1ReadLimit ?? selected.reading.length;
			if (readIndex < readLimit) {
				const paths = selected.reading.slice(readIndex, Math.min(readLimit, readIndex + (script.batchSize ?? 1)));
				readIndex += paths.length;
				return fauxAssistantMessage(paths.map(path => {
					const id = `scripted-${++callId}`; readCallIds.set(path, id);
					return fauxToolCall("read", { path }, { id });
				}), { stopReason: "toolUse" });
			}
			if (!ready) { ready = true; return fauxAssistantMessage("READY"); }
			if (!recalled) {
				recalled = true;
				const target = selected.id === "config-aggregate" ? "modules/module-2.mjs" : selected.reading[0]!;
				const originalCallId = readCallIds.get(target);
				const result = context.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === originalCallId);
				const pointer = result ? text(result) : "";
				const id = pointer.includes("offloaded before compaction") ? pointer.match(/obs_[a-f0-9]{24}/u)?.[0] : undefined;
				return id ? call("obs_recall", { id, offset: 0 }) : call("read", { path: target });
			}
			if (!detailChecked) {
				detailChecked = true;
				const last = context.messages.filter((m: any) => m.role === "toolResult").at(-1);
				if (selected.id === "deferred-exact" && !text(last).includes(`EXACT_CODE=${selected.answer}`)) throw new Error("Exact detail was not recovered from the tool result");
			}
			const solution = Object.entries(selected.solution)[solutionIndex];
			if (solution) { solutionIndex++; return call("write", { path: solution[0], content: solution[1] }); }
			if (stress && !ordinaryRead) { ordinaryRead = true; return call("read", { path: "ordinary.txt" }); }
			// Ordinary Observation Pack sends raw content twice before projecting it.
			if (stress && ordinaryWait++ < 2) return call("read", { path: "manifest.json" });
			if (stress && !ordinaryRecall) {
				ordinaryRecall = true;
				const pointer = context.messages.filter((m: any) => m.role === "toolResult").map(text).find((s: string) => s.includes("large tool result replaced"));
				const id = pointer?.match(/obs_[a-f0-9]{24}/u)?.[0];
				if (!id) throw new Error("Ordinary Observation Pack pointer missing");
				return call("obs_recall", { id, offset: 0 });
			}
			if (stress && !inflated) { inflated = true; return fauxAssistantMessage("synthetic unoffloadable reasoning\n".repeat(10_000)); }
			return fauxAssistantMessage(selected.answer);
		};
		faux.setResponses(Array.from({ length: 150 }, () => response));
		const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		return runtime;
	};
}
