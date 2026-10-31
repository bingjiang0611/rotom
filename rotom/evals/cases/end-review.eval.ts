import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "../src/pi-harness.ts";
import { endReviewCases, endReviewFixturesIntact, type EndReviewCase } from "../src/end-review-regressions.ts";
import { reviewStopping } from "../src/end-review.ts";
import { assertBundledReviewer } from "../src/end-review-shadow.ts";

if (process.env.ROTOM_EVAL_END_REVIEW !== "1") {
	describe.skip("end review requires explicit model-eval authorization", () => {});
} else {
	const product = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT;
	const provider = process.env.ROTOM_EVAL_PROVIDER;
	const model = process.env.ROTOM_EVAL_MODEL;
	const selected = process.env.ROTOM_EVAL_END_REVIEW_CASE;
	const repeats = Number(process.env.ROTOM_EVAL_REPEATS ?? "1");
	if (!product || !isAbsolute(product) || !provider || !model) throw new Error("End review requires an absolute product and explicit provider/model.");
	if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3) throw new Error("ROTOM_EVAL_REPEATS must be 1..3.");
	if (selected && !endReviewCases.some(item => item.id === selected)) throw new Error("Unknown ROTOM_EVAL_END_REVIEW_CASE.");
	assertBundledReviewer(product);

	type Output = { status: string; report: string; calls: number; reportedTokens: number; filesRead: string[]; unchanged: boolean };
	function harness(item: EndReviewCase) {
		let ctx: ExtensionContext;
		let api: ExtensionAPI;
		let result: Output | undefined;
		let evidence = "";
		let snapshot: Record<string, string> = {};
		return createPiCodingAgentHarness<Output>({
			name: "read-only-review", productAgentDir: product,
			model: { provider: provider!, id: model! }, thinkingLevel: "high", tools: [],
			environment: { ROTOM_OBSERVABILITY: "0" },
			inlineExtensions: [(pi) => {
				api = pi;
				let bootstrapTurns = 0;
				pi.on("before_agent_start", (_event, context) => { ctx = context; });
				pi.on("turn_start", (_event, context) => {
					if (++bootstrapTurns > 1) { context.abort(); throw new Error("Reviewer bootstrap permits only one executor response."); }
				});
			}],
			async setupWorkspace({ workspace, configDir }) {
				for (const [name, body] of Object.entries(item.files)) await writeFile(join(workspace, name), body, { flag: "wx", mode: 0o600 });
				// Fixture preparation, not a reviewer capability. A nonzero exit is a
				// real failed check that some negative controls deliberately preserve.
				const run = spawnSync(process.execPath, ["verify.mjs"], { cwd: workspace, encoding: "utf8", timeout: 5000 });
				if (run.error || ![0, 1].includes(run.status!)) throw new Error("Fixture verification did not finish normally.");
				snapshot = { ...item.files, "verification.json": await readFile(join(workspace, "verification.json"), "utf8") };
				const immutableFilesMatchFrozenSource = await endReviewFixturesIntact(workspace, item);
				if (!immutableFilesMatchFrozenSource) throw new Error("Fixture integrity preflight failed.");
				evidence = JSON.stringify({ command: "node verify.mjs", exitCode: run.status, stdout: run.stdout, files: Object.keys(snapshot), harnessPreflight: { immutableFilesMatchFrozenSource, scope: "protected fixture files only; mutable configuration correctness is not assessed" } });
				for (const name of Object.keys(snapshot)) await chmod(join(workspace, name), 0o400);
				await writeFile(join(configDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }), { flag: "wx", mode: 0o600 });
			},
			async continuePrompt({ signal }) {
				if (result) throw new Error("Reviewer calibration must run only once.");
				const review = await reviewStopping(ctx!, api!, signal ?? new AbortController().signal, { task: item.task, claim: item.claim, evidence, requiredFiles: Object.keys(snapshot) });
				const unchanged = (await Promise.all(Object.entries(snapshot).map(async ([name, body]) => await readFile(join(ctx!.cwd, name), "utf8") === body))).every(Boolean);
				result = { status: review.status, report: review.report, calls: review.calls, reportedTokens: review.reportedTokens, filesRead: review.files.map(file => file.path), unchanged };
				api!.appendEntry("eval-end-review-v1", result);
				// Read-only calibration: never queue a repair or another review.
				return undefined;
			},
			output() { if (!result) throw new Error("Missing review result."); return result; },
		});
	}
	for (const item of endReviewCases.filter(item => !selected || item.id === selected)) {
		for (let repetition = 1; repetition <= repeats; repetition++) {
			const judge = createJudge<PiCodingAgentInput, Output>(`stop-${item.id}`, ({ output }) => ({ score: Number(output.status === item.expected && output.unchanged), metadata: { expected: item.expected, actual: output.status, unchanged: output.unchanged, calls: output.calls, reviewerTokens: output.reportedTokens } }));
			describeEval(`${item.id}: repetition ${repetition}`, { harness: harness(item), judges: [judge], judgeThreshold: 1 }, (it) => {
				it("calibrate a stopping reviewer against independently verified end states", async ({ run }) => {
					// One unscored bootstrap request initializes the native selected
					// provider/session. It is not an executor trial; usage is included.
					await run("Reply only review-context-ready. Do not inspect or change the workspace.");
				});
			});
		}
	}
}
