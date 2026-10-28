import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "../src/pi-harness.ts";
import { assertIdentityRead, identityCases, identityFixtureFiles, identityOutputInstruction, scoreIdentity, type IdentityOutput, type IdentityRead } from "../src/session-identity-regressions.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

const enabled = process.env.ROTOM_EVAL_SESSION_IDENTITY === "1";
if (!enabled) {
	describe.skip("session identity requires explicit model-eval authorization", () => {});
} else {
	const baseline = process.env.ROTOM_EVAL_BASELINE_PRODUCT;
	const candidate = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT;
	const provider = process.env.ROTOM_EVAL_PROVIDER;
	const model = process.env.ROTOM_EVAL_MODEL;
	const repetitions = Number(process.env.ROTOM_EVAL_REPEATS ?? "2");
	const selected = process.env.ROTOM_EVAL_IDENTITY_CASE;
	if (!baseline || !candidate || !isAbsolute(baseline) || !isAbsolute(candidate) || !provider || !model) {
		throw new Error("Session identity requires absolute baseline/candidate products and an explicit provider/model.");
	}
	if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_REPEATS must be 1..5.");
	if (selected && !identityCases.some((item) => item.id === selected)) throw new Error("Unknown ROTOM_EVAL_IDENTITY_CASE.");
	const executables = new Map<string, string>();
	for (const product of new Set([baseline, candidate])) {
		const { resolveInstalledPi } = await import(pathToFileURL(join(product, "runtime/resolve-installed-pi.mjs")).href);
		executables.set(product, await resolveInstalledPi(product));
	}
	function harness(name: string, product: string) {
		let reads: IdentityRead[] = [];
		return createPiCodingAgentHarness<IdentityOutput>({
			name, productAgentDir: product, piExecutable: executables.get(product),
			model: { provider: provider!, id: model! }, thinkingLevel: "high", tools: ["read"],
			environment: { ROTOM_OBSERVABILITY: "0" },
			inlineExtensions: [(pi) => {
				reads = [];
				let turns = 0;
				const admitted = new Map<string, string>();
				pi.on("before_agent_start", () => {
					if (pi.getActiveTools().join(",") !== "read") throw new Error("Unexpected active tool surface.");
				});
				pi.on("turn_start", (_event, ctx) => { if (++turns > 6) ctx.abort(); });
				pi.on("tool_call", async (event, ctx) => {
					admitted.set(event.toolCallId, await assertIdentityRead(ctx.cwd, event.toolName, event.input));
				});
				pi.on("tool_result", (event) => {
					const file = admitted.get(event.toolCallId);
					if (!file) throw new Error("Unadmitted tool result.");
					reads.push({ file, isError: event.isError, content: event.content.filter((part) => part.type === "text").map((part) => part.text).join("") });
				});
			}],
			async setupWorkspace({ workspace, configDir }) {
				for (const [file, body] of Object.entries(identityFixtureFiles)) await writeFile(join(workspace, file), body, { flag: "wx", mode: 0o400 });
				await writeFile(join(configDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }), { flag: "wx", mode: 0o600 });
			},
			async output({ workspace, response, session }) {
				const last = session.messages.filter((message) => message.role === "assistant").at(-1);
				const intact = await Promise.all(Object.entries(identityFixtureFiles).map(async ([file, body]) => await readFile(join(workspace, file), "utf8") === body));
				const toolErrors = session.messages.filter((message) => message.role === "toolResult" && message.isError).length;
				return { response, stopReason: last?.stopReason ?? "unknown", reads, fixturesIntact: intact.every(Boolean), toolErrors };
			},
		});
	}
	for (const item of identityCases.filter((entry) => !selected || selected === entry.id)) {
		const judge = createJudge<PiCodingAgentInput, IdentityOutput>(`identity-${item.id}`, ({ output }) => {
			const result = scoreIdentity(item, output);
			return { score: result.score, metadata: { output: { ...result.checks, toolErrors: output.toolErrors } } };
		});
		const planned = evalHarnessTable(`session-identity-${item.id}`, { baseline: harness("baseline", baseline), candidate: harness("candidate", candidate), repetitions });
		for (let repetition = 1; repetition <= repetitions; repetition++) {
			const rows = planned.filter((row) => row.repetition === repetition);
			if (repetition % 2 === 0) rows.reverse();
			for (const row of rows) describeEval(`${item.id}: ${row.name} repetition ${repetition}`, {
				harness: row.harness, judges: [judge], judgeThreshold: row.name === "candidate" ? 1 : null,
			}, (it) => {
				it("ground identity in completed native reads", async ({ run }) => {
					await run({ id: item.id, steps: [{ type: "prompt", content: `${item.task}\n\n${identityOutputInstruction}` }] });
				});
			});
		}
	}
}
