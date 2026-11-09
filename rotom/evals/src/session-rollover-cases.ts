import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createPiCodingAgentHarness, type PiCodingAgentHarnessOptions, type PiCodingAgentScenario } from "./pi-harness.ts";

/**
 * Two-arm replay for the summary-free rollover: identical task, identical compaction settings, only
 * `ROTOM_SESSION_ROLLOVER` differs. The detail the task asks for is recorded early, then cut away by
 * the compaction, so an arm that cannot retrieve it answers wrong instead of guessing.
 */
export const ROLLOVER_PRODUCT = resolve(import.meta.dirname, "../..");
/** Context window of the replay model is fixed by the harness; the threshold is derived from it. */
export const ROLLOVER_THRESHOLD = 16_000;
export const ROLLOVER_KEEP_RECENT = 2_000;
export const ROLLOVER_TOOLS = ["read", "context_recall"];

/** Not derivable from the task text: only the recorded entry carries it. */
export const EXACT_DETAIL = createHash("sha256").update("session-rollover-replay-exact-detail-v1").digest("hex").slice(0, 40);

function padded(key: string, body: string) {
	let seed = createHash("sha256").update(`rollover-replay/${key}`).digest().readUInt32LE(0);
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	const lines: string[] = [];
	let bytes = Buffer.byteLength(body) + 1;
	while (bytes < 3_072) {
		const index = lines.length;
		const line = `2026-02-0${(index % 9) + 1}T08:${String(index % 60).padStart(2, "0")}:00Z INFO worker-${next() % 32} handled batch ${next() % 10_000}; duration_ms=${next() % 900}; status=ok`;
		const lineBytes = Buffer.byteLength(line) + 1;
		if (bytes + lineBytes > 3_072) break;
		lines.push(line);
		bytes += lineBytes;
	}
	lines.splice(Math.floor(lines.length / 2), 0, body);
	return `${lines.join("\n")}\n`;
}

/** The bulk note is the one that pushes the next request past the threshold. */
const BULK = `${"filler audit line for the synthetic bulk note; no executable behavior\n".repeat(900)}`;

export type RolloverTask = {
	id: string;
	files: Readonly<Record<string, string>>;
	/** Files the scripted model reads, in order; the exact detail is recorded first. */
	reading: readonly string[];
	answer: string;
	scenario: PiCodingAgentScenario;
};

function task(id: string, files: Record<string, string>): RolloverTask {
	const reading = ["logs/exact.txt", "logs/bulk.txt", ...Object.keys(files).filter((path) => path.startsWith("notes/"))];
	files["manifest.json"] = JSON.stringify(["logs/exact.txt", "logs/bulk.txt", ...Object.keys(files).filter((path) => path.startsWith("notes/"))], null, 2);
	return Object.freeze<RolloverTask>({
		id,
		files: Object.freeze(files),
		reading: Object.freeze(reading),
		answer: EXACT_DETAIL,
		scenario: {
			id,
			steps: [
				{
					type: "prompt",
					content:
						"Read manifest.json, then read every listed file individually and in order. Do not edit files. When you have read them all, reply READY. A separate follow-up will ask for one recorded value.",
				},
				{ type: "prompt", content: "Reply with the exact 40-character EXACT_CODE you recorded earlier. No explanation, no other text." },
			],
		},
	});
}

export const ROLLOVER_TASKS: readonly RolloverTask[] = Object.freeze([
	task("early-detail", {
		"logs/exact.txt": padded("logs/exact.txt", `EXACT_CODE=${EXACT_DETAIL}`),
		"logs/bulk.txt": BULK,
		...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`notes/note-${index}.txt`, padded(`note-${index}`, `// Synthetic note ${index}; carries EVENT_CODE=synthetic-${index}, not the answer.`)])),
	}),
]);

export async function writeRolloverFixture(workspace: string, selected: RolloverTask) {
	for (const [path, content] of Object.entries(selected.files)) {
		await mkdir(dirname(join(workspace, path)), { recursive: true });
		await writeFile(join(workspace, path), content);
	}
}

/** The output must be the recorded detail, and no fixture byte may change. */
export async function gradeRollover(selected: RolloverTask, workspace: string, response: string): Promise<boolean> {
	if (response.trim() !== selected.answer) return false;
	for (const [path, original] of Object.entries(selected.files)) {
		let actual: string;
		try {
			actual = await readFile(join(workspace, path), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		if (actual !== original) return false;
	}
	return true;
}

export type RolloverMetrics = {
	correct: boolean;
	requests: number;
	/** Provider-reported usage sums; `usageKnown` is false when any request omitted usage. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	usageKnown: boolean;
	compactions: number;
	nativeSummaries: number;
	rolloverEntries: number;
	/** Provider-reported spend in USD when the model has pricing, otherwise `null` = unknown. */
	costUsd: number | null;
	costUnknownReason: string | null;
	wallMs: number;
};

/** Summary-call accounting for one finished replay run. Tokens only; no currency conversion. */
export function rolloverMetrics(branch: SessionEntry[], correct: boolean, pricing: boolean, wallMs = 0): RolloverMetrics {
	const metrics: RolloverMetrics = {
		correct,
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		usageKnown: true,
		compactions: 0,
		nativeSummaries: 0,
		rolloverEntries: 0,
		costUsd: null,
		costUnknownReason: pricing ? null : "provider-report-unknown",
		wallMs,
	};
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			if (!usage) {
				metrics.usageKnown = false;
				continue;
			}
			metrics.requests++;
			metrics.inputTokens += usage.input ?? 0;
			metrics.outputTokens += usage.output ?? 0;
			metrics.cacheReadTokens += usage.cacheRead ?? 0;
			metrics.cacheWriteTokens += usage.cacheWrite ?? 0;
			const cost = (usage as { cost?: { total?: number } }).cost?.total;
			// `cost.total` is Provider reported; summing it is accounting, not a price estimate.
			if (typeof cost === "number" && Number.isFinite(cost)) metrics.costUsd = (metrics.costUsd ?? 0) + cost;
			continue;
		}
		if (entry.type !== "compaction") continue;
		metrics.compactions++;
		if (entry.fromHook === true) {
			if ((entry.details as { kind?: unknown } | undefined)?.kind === "rotom-rollover") metrics.rolloverEntries++;
		} else metrics.nativeSummaries++;
	}
	return metrics;
}

type RolloverHarnessOptions = Pick<PiCodingAgentHarnessOptions, "piExecutable" | "thinkingLevel"> & { model?: PiCodingAgentHarnessOptions["model"] } & {
	modelRuntimeFactory: NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]>;
	/** Turn the retrieval tool off, to prove a failed retrieval is graded wrong rather than guessed. */
	disableContextLayers?: boolean;
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
		tools: options.disableContextLayers ? ["read"] : [...ROLLOVER_TOOLS],
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
			if (!model || model.contextWindow <= ROLLOVER_THRESHOLD) throw new Error("Rollover replay needs a model window above the fixed threshold");
			// Same compaction settings in both arms; only the rollover switch differs.
			await writeFile(join(context.configDir, "settings.json"), JSON.stringify({
				retry: { enabled: false },
				compaction: { enabled: true, reserveTokens: model.contextWindow - ROLLOVER_THRESHOLD, keepRecentTokens: ROLLOVER_KEEP_RECENT },
			}));
			return runtime;
		},
		async output({ session, workspace, response }) {
			const correct = await gradeRollover(selected, workspace, response);
			const cost = session.model?.cost;
			pricing = !!cost && Object.values(cost).some((value) => typeof value === "number" && value > 0);
			lastBranch = session.sessionManager.getBranch();
			return rolloverMetrics(lastBranch, correct, pricing);
		},
	});
	const run: typeof harness.run = async (input, context) => {
		const started = performance.now();
		lastBranch = undefined;
		pricing = false;
		const result = await harness.run(input, context);
		return { ...result, output: { ...result.output, wallMs: performance.now() - started } };
	};
	return {
		...harness,
		run,
		/** Metrics for a failed run, so an unusable sample is still recorded. */
		failureMetrics: () => (lastBranch ? rolloverMetrics(lastBranch, false, pricing) : null),
	};
}

/**
 * Scripted local model: read the manifest and every listed file, cross the threshold on the bulk
 * note, recover the early detail with `context_recall`, then answer with it. A summary request is
 * answered too, so the native arm can finish. No network, no credentials, no generated judgment.
 */
export function rolloverFaux(
	selected: RolloverTask,
	profile = { provider: "rotom-rollover-faux", id: "replay", contextWindow: 32_000 },
): NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]> {
	return async ({ product, configDir }) => {
		// Resolve the faux provider from the product's own Pi install, not from this package.
		const fauxModule = pathToFileURL(resolve(product.verified.packageRoot, "../pi-ai/dist/providers/faux.js")).href;
		const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(fauxModule);
		const faux = fauxProvider({ provider: profile.provider, models: [{ id: profile.id, contextWindow: profile.contextWindow, maxTokens: 4_096 }] });
		const text = (message: any) => (typeof message.content === "string" ? message.content : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
		let readIndex = 0;
		let recalled = false;
		let ready = false;
		let callId = 0;
		const response = (context: any) => {
			const systems = context.messages.filter((message: any) => message.role === "system");
			if (systems.some((message: any) => text(message).includes("context summarization assistant"))) {
				// The native arm summarizes; the summary never contains the recorded code.
				return fauxAssistantMessage("## Goal\nFinish the synthetic audit.\n## Progress\nFiles were read; the requested value is not repeated here.\n## Next steps\nAnswer the follow-up.");
			}
			const lastUser = context.messages.filter((message: any) => message.role === "user").at(-1);
			if (ready && lastUser) {
				if (!recalled) {
					recalled = true;
					return fauxAssistantMessage(fauxToolCall("context_recall", { query: "EXACT_CODE" }, { id: `scripted-${++callId}` }), { stopReason: "toolUse" });
				}
				const recalledText = context.messages.filter((message: any) => message.role === "toolResult").map(text).join("\n");
				// Without a successful retrieval the recorded value is unavailable: answer empty rather
				// than guess, which the grader then marks wrong.
				return fauxAssistantMessage(recalledText.includes(selected.answer) ? selected.answer : "unknown");
			}
			if (readIndex < selected.reading.length) {
				const path = selected.reading[readIndex++] as string;
				return fauxAssistantMessage(fauxToolCall("read", { path }, { id: `scripted-${++callId}` }), { stopReason: "toolUse" });
			}
			ready = true;
			return fauxAssistantMessage("READY");
		};
		faux.setResponses(Array.from({ length: 60 }, () => response));
		const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		return runtime;
	};
}

export const ROLLOVER_FAUX_MODEL = { provider: "rotom-rollover-faux", id: "replay" } as const;
