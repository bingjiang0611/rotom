import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import { createPiCodingAgentHarness, type PiCodingAgentInput, type PiCodingAgentScenario } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const baselineProduct = process.env.ROTOM_EVAL_BASELINE_PRODUCT?.trim();
const candidateProduct = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_REPEATS ?? "3");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_REPEATS must be an integer from 1 to 5.");

function policyFrom(name: string): string {
	const path = process.env[name]?.trim();
	return path ? readFileSync(path, "utf8").trim() : "(no additional policy for this variant)";
}

const baselinePolicy = policyFrom("ROTOM_EVAL_BASELINE_POLICY_FILE");
const candidatePolicy = policyFrom("ROTOM_EVAL_CANDIDATE_POLICY_FILE");

type PlanOutput = { response: string };
type RecordValue = Record<string, JsonValue>;

function parseObject(response: string): RecordValue | undefined {
	const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? response;
	const start = fenced.indexOf("{");
	const end = fenced.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed = JSON.parse(fenced.slice(start, end + 1));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RecordValue : undefined;
	} catch { return undefined; }
}

function text(value: JsonValue | undefined): string {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function stringList(value: JsonValue | undefined): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()) : [];
}

const laneJudge = createJudge<PiCodingAgentInput, PlanOutput>("SingleLaneReuseJudge", ({ output }) => {
	const plan = parseObject(output.response);
	const handoff = stringList(plan?.handoffFields);
	const checks = {
		json: plan !== undefined,
		pendingLane: text(plan?.beforeRunRootLaneKey).includes("pi") && text(plan?.beforeRunRootLaneKey).includes("pending"),
		runRootLane: text(plan?.afterRunRootLaneKey).includes("pi") && /run[_ -]?root/u.test(text(plan?.afterRunRootLaneKey)),
		oneWorker: plan?.activeWorkersPerLane === 1,
		freshContext: text(plan?.initialWorkerContext).includes("fresh"),
		steerLive: text(plan?.whileWorkerLive).includes("steer"),
		resumeCompleted: text(plan?.afterWorkerCompletes).includes("resume"),
		compactHandoff: handoff.some((item) => item.includes("provider"))
			&& handoff.some((item) => /run[_ -]?root/u.test(item))
			&& handoff.some((item) => item.includes("lifecycle"))
			&& handoff.some((item) => /evidence|artifact/u.test(item))
			&& handoff.some((item) => /next.*step|next.*command/u.test(item))
			&& handoff.some((item) => /block|decision/u.test(item)),
		replacementBounded: /not resumable|cannot be resumed|unrecoverable|不可恢复/u.test(text(plan?.replacementAllowedWhen)),
		oldWorkerTerminal: /terminated|stopped|terminal|已终止/u.test(text(plan?.oldWorkerStateBeforeReplacement)),
		noFullHistoryFork: plan?.forkFullParentHistoryAgain === false,
	};
	return { score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length, metadata: { rationale: JSON.stringify(checks), output: { checks, plan: plan ?? null } } };
});

const staleJudge = createJudge<PiCodingAgentInput, PlanOutput>("StaleStateRecoveryJudge", ({ output }) => {
	const plan = parseObject(output.response);
	const retryOutcome = text(plan?.ifRetryIsStaleAgain);
	const checks = {
		json: plan !== undefined,
		observeFirst: text(plan?.nextTool) === "observe_ui",
		freshState: /new|fresh|latest|observe/u.test(text(plan?.stateIdForNextAct)) && !text(plan?.stateIdForNextAct).includes("s_old"),
		freshRef: /new|fresh|latest|observe/u.test(text(plan?.refForNextAct)) && !text(plan?.refForNextAct).includes("@e17"),
		noOldReuse: plan?.reuseOldStateOrRef === false,
		oneRetry: plan?.maximumActionRetries === 1,
		stopAfterRetry: /stop|report|fail|ask|停止|报告/u.test(retryOutcome)
			&& (/do not retry|not retry|stop_and_do_not_retry|不再重试/u.test(retryOutcome) || !/retry again|loop|继续重试/u.test(retryOutcome)),
	};
	return { score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length, metadata: { rationale: JSON.stringify(checks), output: { checks, plan: plan ?? null } } };
});

const laneScenario: PiCodingAgentScenario = {
	id: "single-lane-reuse-plan",
	steps: [{ type: "prompt", content: `Plan, but do not execute, how you would delegate one validate-demo-workflow run for provider pi. Step 0 has not created run_root yet; later the user returns after a checkpoint, and eventually the worker may become unavailable. Return only one JSON object with exactly these fields: beforeRunRootLaneKey, afterRunRootLaneKey, activeWorkersPerLane, initialWorkerContext, whileWorkerLive, afterWorkerCompletes, handoffFields (array), replacementAllowedWhen, oldWorkerStateBeforeReplacement, forkFullParentHistoryAgain. Do not call tools.` }],
};

const staleScenario: PiCodingAgentScenario = {
	id: "stale-ui-recovery-plan",
	steps: [{ type: "prompt", content: `An act_ui action using stateId S_old and ref @e17 failed with: "Outline ref '@e17' is stale or not available for the latest state." Plan the recovery without executing tools. Return only one JSON object with exactly these fields: nextTool, stateIdForNextAct, refForNextAct, reuseOldStateOrRef, maximumActionRetries, ifRetryIsStaleAgain. Do not call tools.` }],
};

if (!provider || !model || !baselineProduct) {
	describe.skip("lane/stale A/B requires provider, model, and ROTOM_EVAL_BASELINE_PRODUCT", () => {});
} else {
	const selectedModel = { provider, id: model };
	const baselineProductPath = baselineProduct;
	function createHarness(name: string, productAgentDir: string, policy: string) {
		return createPiCodingAgentHarness<PlanOutput>({
			name,
			model: selectedModel,
			thinkingLevel: "low",
			noTools: "all",
			productAgentDir,
			transformSystemPrompt: (defaultPrompt) => `${defaultPrompt}\n\nVariant-specific product/skill policy:\n${policy}`,
			output: ({ response }) => ({ response }),
		});
	}
	function rowsFor(label: string) {
		const planned = evalHarnessTable(label, {
			baseline: createHarness("baseline", baselineProductPath, baselinePolicy),
			candidate: createHarness("candidate", candidateProduct, candidatePolicy),
			repetitions,
		});
		return Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
	}
	for (const row of rowsFor("single lane reuse")) {
		describeEval(`single lane reuse: ${row.name} repetition ${String(row.repetition)}`, {
			harness: row.harness,
			judges: [laneJudge],
			judgeThreshold: row.name === "candidate" ? 1 : null,
		}, (it) => { it("plans one resumable worker lane", async ({ run }) => { await run(laneScenario); }); });
	}
	for (const row of rowsFor("stale UI recovery")) {
		describeEval(`stale UI recovery: ${row.name} repetition ${String(row.repetition)}`, {
			harness: row.harness,
			judges: [staleJudge],
			judgeThreshold: row.name === "candidate" ? 1 : null,
		}, (it) => { it("plans fresh observe and bounded retry", async ({ run }) => { await run(staleScenario); }); });
	}
}
