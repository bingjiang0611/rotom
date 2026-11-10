/**
 * Arms and evidence for the Subagent on/off pairing. Kept apart from the eval file so
 * the offline oracle can build the same arms without a live model.
 */
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJudge } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import { createPiCodingAgentHarness, type PiCodingAgentHarnessOptions, type PiCodingAgentInput } from "./pi-harness.ts";
import { BASE_TOOLS, SUBAGENT_TOOLS, scoreSubagentAbCase, subagentAbCases } from "./subagent-ab-cases.ts";

export type SubagentAbOutput = {
	caseId: string;
	response: string;
	toolCallCount: number;
	subagentCalls: number;
	/** Parent-session usage only; child runs report their own usage in the Subagent store. */
	parentUsage: { input: number; output: number; cacheRead: number };
};

export const SUBAGENT_AB_ARMS = { baseline: [...BASE_TOOLS], candidate: [...BASE_TOOLS, ...SUBAGENT_TOOLS] } as const;

const CONTRACT = "This is a read-only fixture workspace: do not edit files, run Git or package commands, or inspect anything outside the supplied cwd. Return the JSON the task asks for as the final message.";

/** The launcher's scoped Subagent store, private to this suite run. */
async function initializeStore(productAgentDir: string, root: string): Promise<void> {
	const packageRoot = resolve(productAgentDir, "extensions/third-party/node_modules/pi-subagents");
	const jitiEntry = resolve(productAgentDir, "extensions/third-party/node_modules/jiti/lib/jiti.mjs");
	for (const path of [jitiEntry, join(packageRoot, "src/shared/execution-store.ts")]) {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Missing Subagent store tool: ${path}`);
	}
	const { createJiti } = await import(pathToFileURL(jitiEntry).href);
	const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
	const { initializeExecutionStore } = await jiti.import(join(packageRoot, "src/shared/execution-store.ts"));
	initializeExecutionStore(root);
}

export async function subagentAbStoreRoot(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "rotom-subagent-ab-")), "store");
}

export function subagentAbHarness(input: {
	arm: keyof typeof SUBAGENT_AB_ARMS;
	productAgentDir: string;
	storeRoot: string;
	model: PiCodingAgentHarnessOptions["model"];
	extra?: Partial<PiCodingAgentHarnessOptions>;
}) {
	let storeReady: Promise<void> | undefined;
	return createPiCodingAgentHarness<SubagentAbOutput & JsonValue>({
		name: input.arm === "candidate" ? "with-subagent" : "without-subagent",
		model: input.model,
		productAgentDir: input.productAgentDir,
		tools: [...SUBAGENT_AB_ARMS[input.arm]],
		// Same scope as the launcher; the baseline arm gets it too so only the tools differ.
		environment: { PI_SUBAGENTS_EXECUTION_SCOPE: "owned-process-groups-v2", PI_SUBAGENTS_TEMP_ROOT: input.storeRoot },
		inlineExtensions: [(pi) => { pi.on("before_agent_start", (event) => { (event.systemPromptOptions.sections ??= {}).fixture_contract = CONTRACT; }); }],
		...input.extra,
		async setupWorkspace(context) {
			storeReady ??= mkdir(dirname(input.storeRoot), { recursive: true, mode: 0o700 }).then(() => initializeStore(input.productAgentDir, input.storeRoot));
			await storeReady;
			const id = !Array.isArray(context.input) && typeof context.input === "object" ? context.input.id : undefined;
			const item = subagentAbCases.find((candidate) => candidate.id === id);
			if (!item) throw new Error(`Unknown Subagent A/B case: ${String(id)}`);
			for (const [path, content] of Object.entries(item.fixture())) {
				await mkdir(dirname(join(context.workspace, path)), { recursive: true });
				await writeFile(join(context.workspace, path), content, "utf8");
			}
			await input.extra?.setupWorkspace?.(context);
		},
		async output({ input: runInput, response, session }) {
			const id = !Array.isArray(runInput) && typeof runInput === "object" ? String(runInput.id) : "";
			let toolCallCount = 0;
			let subagentCalls = 0;
			const parentUsage = { input: 0, output: 0, cacheRead: 0 };
			for (const message of session.messages) {
				if (message.role !== "assistant") continue;
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					toolCallCount++;
					if (part.name === "subagent") subagentCalls++;
				}
				parentUsage.input += message.usage?.input ?? 0;
				parentUsage.output += message.usage?.output ?? 0;
				parentUsage.cacheRead += message.usage?.cacheRead ?? 0;
			}
			return { caseId: id, response: response.length > 8_000 ? `${response.slice(0, 8_000)}…` : response, toolCallCount, subagentCalls, parentUsage } as SubagentAbOutput & JsonValue;
		},
	});
}

export function subagentAbJudge(caseId: string) {
	return createJudge<PiCodingAgentInput, SubagentAbOutput & JsonValue>(`SubagentAB-${caseId}`, ({ output }) => {
		const value = output as unknown as SubagentAbOutput;
		const { passed, checks } = scoreSubagentAbCase(caseId, value.response);
		return {
			score: passed ? 1 : 0,
			metadata: {
				rationale: JSON.stringify(checks),
				output: { checks, toolCallCount: value.toolCallCount, subagentCalls: value.subagentCalls, parentUsage: value.parentUsage } as JsonValue,
			},
		};
	});
}
