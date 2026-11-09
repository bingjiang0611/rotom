import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createPiCodingAgentHarness, type PiCodingAgentHarnessOptions } from "./pi-harness.ts";
import { rolloverMetrics, type RolloverMetrics } from "./session-rollover-metrics.ts";
import {
	gradeRollover,
	LOCKED_CONFIG_PATH,
	NO_HINT_MARKER,
	NO_HINT_SUMMARY_PATH,
	rolloverGradeReason,
	ROLLOVER_KEEP_RECENT,
	ROLLOVER_THRESHOLD,
	ROLLOVER_PRODUCT,
	type RolloverTask,
	writeRolloverFixture,
} from "./session-rollover-tasks.ts";

/**
 * The two-arm harness and the scripted local model. Tasks and grading live in
 * `session-rollover-tasks.ts`, metrics in `session-rollover-metrics.ts`.
 */
type RolloverHarnessOptions = Pick<PiCodingAgentHarnessOptions, "piExecutable" | "thinkingLevel"> & { model?: PiCodingAgentHarnessOptions["model"] } & {
	modelRuntimeFactory: NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]>;
	/** Turn the retrieval tool off, to prove a failed retrieval is graded wrong rather than guessed. */
	disableContextLayers?: boolean;
	/** Receives the finalized metrics of a completed run; used to record live rows. */
	onMetrics?: (metrics: RolloverMetrics) => void;
	/**
	 * Context window of the selected model. Extension-provided providers such as `qoder` only
	 * resolve after the product registers them, which happens after this factory runs, so the live
	 * path passes the window it read from the same persisted model store Pi uses.
	 */
	contextWindow?: number;
};

export function createRolloverHarness(selected: RolloverTask, candidate: boolean, options: RolloverHarnessOptions) {
	let lastBranch: SessionEntry[] | undefined;
	let pricing = false;
	const harness = createPiCodingAgentHarness<RolloverMetrics>({
		...options,
		name: candidate ? "rollover" : "native-summary",
		productAgentDir: ROLLOVER_PRODUCT,
		piExecutable: options.piExecutable ?? resolve(ROLLOVER_PRODUCT, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
		thinkingLevel: options.thinkingLevel ?? "off",
		tools: options.disableContextLayers ? selected.tools.filter((tool) => tool !== "context_recall") : [...selected.tools],
		inlineExtensions: [
			(pi) => {
				pi.on("session_shutdown", (_event, ctx) => {
					lastBranch = ctx.sessionManager.getBranch();
				});
			},
		],
		inlineExtensionsFirst: true,
		environment: {
			ROTOM_SESSION_ROLLOVER: candidate ? "1" : "0",
			ROTOM_CONTEXT_LAYERS: options.disableContextLayers ? "0" : undefined,
			PI_CODING_AGENT_DIR: undefined,
		},
		async setupWorkspace({ workspace, configDir }) {
			process.env.PI_CODING_AGENT_DIR = configDir;
			await writeRolloverFixture(workspace, selected);
		},
		async modelRuntimeFactory(context) {
			const runtime = await options.modelRuntimeFactory(context);
			const model = options.model ? runtime.getModel(options.model.provider, options.model.id) : runtime.getModels?.()[0];
			const contextWindow = options.contextWindow ?? model?.contextWindow;
			if (!contextWindow || contextWindow <= ROLLOVER_THRESHOLD) throw new Error("Rollover replay needs a model window above the fixed threshold");
			// Same compaction settings in both arms; only the rollover switch differs.
			await writeFile(join(context.configDir, "settings.json"), JSON.stringify({
				retry: { enabled: false },
				compaction: { enabled: true, reserveTokens: contextWindow - ROLLOVER_THRESHOLD, keepRecentTokens: ROLLOVER_KEEP_RECENT },
			}));
			return runtime;
		},
		async output({ session, workspace, response }) {
			const correct = await gradeRollover(selected, workspace, response);
			const cost = session.model?.cost;
			pricing = !!cost && Object.values(cost).some((value) => typeof value === "number" && value > 0);
			lastBranch = session.sessionManager.getBranch();
			const metrics = rolloverMetrics(lastBranch, correct, pricing);
			if (!correct) metrics.gradeReason = await rolloverGradeReason(selected, workspace, response);
			if (selected.verify && selected.files[NO_HINT_SUMMARY_PATH] === undefined) {
				metrics.ruleObeyed = await selected.verify(workspace);
			}
			return metrics;
		},
	});
	const run: typeof harness.run = async (input, context) => {
		const started = performance.now();
		lastBranch = undefined;
		pricing = false;
		const result = await harness.run(input, context);
		const output = { ...result.output, wallMs: performance.now() - started };
		options.onMetrics?.(output);
		return { ...result, output };
	};
	return {
		...harness,
		run,
		/** Metrics for a failed run, so an unusable sample is still recorded. */
		failureMetrics: () => (lastBranch ? rolloverMetrics(lastBranch, false, pricing) : null),
	};
}

export type FauxBehavior = "retrieve" | "ignore";

/**
 * Scripted local model. For `early-detail` it reads the manifest and the listed files, crosses the
 * threshold on the bulk note, recovers the exact code with `context_recall` and answers with it. For
 * `no-hint` it reads the files and writes the summary; `ignore` skips the retrieval at the point
 * where a model that never considered the earlier rule would skip it.
 *
 * The script never reads the fixture from disk for its answer: it only looks at its own context, so a
 * run passes only when the rule or the code is still reachable from the conversation.
 */
export function rolloverFaux(
	selected: RolloverTask,
	options: { behavior?: FauxBehavior; profile?: { provider: string; id: string; contextWindow: number } } = {},
): NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]> {
	const behavior = options.behavior ?? "retrieve";
	const profile = options.profile ?? { provider: "rotom-rollover-faux", id: "replay", contextWindow: 32_000 };
	return async ({ product, configDir }) => {
		// Resolve the faux provider from the product's own Pi install, not from this package.
		const fauxModule = pathToFileURL(resolve(product.verified.packageRoot, "../pi-ai/dist/providers/faux.js")).href;
		const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(fauxModule);
		const faux = fauxProvider({ provider: profile.provider, models: [{ id: profile.id, contextWindow: profile.contextWindow, maxTokens: 4_096 }] });
		const text = (message: any) =>
			typeof message.content === "string" ? message.content : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
		const contextText = (context: any) => context.messages.map(text).join("\n");
		let readIndex = 0;
		let ready = false;
		let recallStep = 0;
		let wrote = false;
		let callId = 0;
		const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args, { id: `scripted-${++callId}` }), { stopReason: "toolUse" });
		const retrieved = (context: any) => text(context.messages.filter((message: any) => message.role === "toolResult").at(-1));
		const response = (context: any) => {
			const systems = context.messages.filter((message: any) => message.role === "system");
			if (systems.some((message: any) => text(message).includes("context summarization assistant"))) return fauxAssistantMessage(selected.nativeSummary);
			const lastUser = context.messages.filter((message: any) => message.role === "user").at(-1);
			const lastUserText = lastUser ? text(lastUser) : "";
			if (selected.id === "no-hint") {
				// The first turn only states the rule; the work happens in the second turn.
				if (lastUserText.startsWith("Project rule")) return fauxAssistantMessage("OK");
				if (wrote) return fauxAssistantMessage(selected.answer ?? "DONE");
				if (readIndex < selected.reading.length) {
					const path = selected.reading[readIndex++] as string;
					return call("read", { path });
				}
				const knowsRule = contextText(context).includes(NO_HINT_MARKER);
				if (!knowsRule && behavior === "retrieve" && recallStep === 0) {
					recallStep = 1;
					return call("context_recall", { query: "first line of every new file" });
				}
				wrote = true;
				const rule = knowsRule || (recallStep === 1 && retrieved(context).includes(NO_HINT_MARKER));
				const first = rule ? `${NO_HINT_MARKER}\n` : "";
				const listed = selected.reading.map((path) => `- ${path}`).join("\n");
				return call("write", { path: NO_HINT_SUMMARY_PATH, content: `${first}${listed}\n` });
			}
			if (readIndex < selected.reading.length) {
				const path = selected.reading[readIndex++] as string;
				return call("read", { path });
			}
			if (!ready) {
				ready = true;
				return fauxAssistantMessage("READY");
			}
			if (recallStep === 0) {
				recallStep = 1;
				if (behavior === "ignore") return fauxAssistantMessage("unknown");
				return call("context_recall", { query: "EXACT_CODE" });
			}
			// Without a successful retrieval the recorded value is unavailable: answer empty rather
			// than guess, which the grader then marks wrong.
			return fauxAssistantMessage(recallStep === 1 && retrieved(context).includes(selected.answer ?? "") ? selected.answer ?? "" : "unknown");
		};
		faux.setResponses(Array.from({ length: 80 }, () => response));
		const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		return runtime;
	};
}

export const ROLLOVER_FAUX_MODEL = { provider: "rotom-rollover-faux", id: "replay" } as const;
