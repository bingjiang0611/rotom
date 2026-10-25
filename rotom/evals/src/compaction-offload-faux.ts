import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PiCodingAgentHarnessOptions } from "./pi-harness.ts";
import { REPLAY_CONFIG, type ReplayTask } from "./compaction-offload-cases.ts";

export const FAUX_MODEL = { provider: "rotom-offload-faux", id: "replay" };
export type FauxObservation = {
	requests: { system: string; tools: string; summary: boolean; maxTokens: number | null; reads: number }[];
	config: unknown; agentDirMatches: boolean; summaryCalls: number; workspace?: string;
};
/** Only scripted local responses. No credentials, network provider, or generated judgment. */
export function replayFaux(selected: ReplayTask, observation: FauxObservation, stress = false): NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]> {
	return async ({ product, configDir }) => {
		const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(resolve(product.verified.packageRoot, "../pi-ai/dist/providers/faux.js")).href);
		const { getCurrentSystemPrompt, getCurrentTools } = await import(pathToFileURL(resolve(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
		const faux = fauxProvider({ provider: FAUX_MODEL.provider, models: [{ id: FAUX_MODEL.id, contextWindow: 256_000, maxTokens: 4096 }] });
		observation.config = JSON.parse(await readFile(join(configDir, "sol-pi.json"), "utf8"));
		observation.agentDirMatches = product.runtime.getAgentDir() === configDir;
		observation.workspace = resolve(configDir, "../workspace");
		if (JSON.stringify(observation.config) !== JSON.stringify(REPLAY_CONFIG) || !observation.agentDirMatches) throw new Error("SoL-Pi configuration is not bound to the isolated agent directory");
		if (stress) await writeFile(resolve(configDir, "../workspace/ordinary.txt"), "ordinary synthetic data\n".repeat(600));
		const normalize = (text: string) => text.split(resolve(configDir, "..")).join("<run>");
		let readIndex = 0, manifestRead = false, ready = false, checkedFailure = false, recalled = false;
		let detailChecked = false;
		let solutionIndex = 0, checked = false, ordinaryRead = false, ordinaryRecall = false, inflated = false;
		let callId = 0, ordinaryWait = 0;
		const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args, { id: `scripted-${++callId}` }), { stopReason: "toolUse" });
		const response = (context: any, options: any) => {
			// Fix faux accounting to uncached input; this is not a cache-price prediction.
			options.cacheRetention = "none";
			const systems = context.messages.filter((m: any) => m.role === "system");
			const text = (m: any) => typeof m.content === "string" ? m.content : m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
			const summary = systems.some((m: any) => text(m).includes("context summarization assistant"));
			observation.requests.push({ system: normalize(getCurrentSystemPrompt(context.messages)), tools: normalize(JSON.stringify(getCurrentTools(context.messages))), summary, maxTokens: options.maxTokens ?? null, reads: readIndex });
			if (summary) {
				observation.summaryCalls++;
				return fauxAssistantMessage("## Goal\nFinish the synthetic audit.\n## Progress\nRead files and continue the requested follow-up.\n## Next steps\nUse the workspace to finish and validate.");
			}
			if (!manifestRead) { manifestRead = true; return call("read", { path: "manifest.json" }); }
			if (readIndex < selected.reading.length) return call("read", { path: selected.reading[readIndex++] });
			if (selected.check === "test.mjs" && !checkedFailure) { checkedFailure = true; return call("bash", { command: "node test.mjs" }); }
			if (!ready) { ready = true; return fauxAssistantMessage("READY"); }
			if (!recalled) {
				recalled = true;
				const target = selected.id === "config-aggregate" ? "modules/module-2.mjs" : selected.reading[0]!;
				const originalCallId = `scripted-${selected.reading.indexOf(target) + 2}`;
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
			if (selected.check && !checked) { checked = true; return call("bash", { command: `node ${selected.check}` }); }
			if (stress && !ordinaryRead) { ordinaryRead = true; return call("read", { path: "ordinary.txt" }); }
			// Ordinary Observation Pack sends raw content twice before projecting it.
			if (stress && ordinaryWait++ < 2) return call("bash", { command: "printf 'synthetic checkpoint\\n'" });
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
