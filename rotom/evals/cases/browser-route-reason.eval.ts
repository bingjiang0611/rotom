import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

// The compared variants are exactly the guard strings each product would really return, extracted
// from that product's own browser extension source. Nothing here is a hand-written policy mock.
const NO_BLOCK_PROJECTION = "(this product's bash guard does not classify local device automation as a browser task, so the command is not rejected)";

function guardReasons(productAgentDir: string): { browserLaunch: string; localDeviceAutomation: string } {
	const source = readFileSync(join(productAgentDir, "extensions/browser/index.ts"), "utf8");
	const constant = (name: string): string | undefined => new RegExp(`const ${name} = "([^"]+)"`, "u").exec(source)?.[1];
	const legacy = constant("BACKGROUND_BROWSER_ROUTE_REASON");
	if (legacy) return { browserLaunch: legacy, localDeviceAutomation: legacy };
	const browserLaunch = constant("BROWSER_FOREGROUND_LAUNCH_REASON");
	if (!browserLaunch) throw new Error(`no browser-route guard reason found in ${productAgentDir}`);
	return { browserLaunch, localDeviceAutomation: NO_BLOCK_PROJECTION };
}

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

const relayRouteJudge = createJudge<PiCodingAgentInput, PlanOutput>("RelayRouteComplianceJudge", ({ output }) => {
	const plan = parseObject(output.response);
	const checks = {
		json: plan !== undefined,
		relayTool: /browser_inspect/u.test(text(plan?.nextTool)),
		noShellLaunch: plan?.useShellBrowserLaunch === false,
		noDesktopCapture: plan?.useDesktopScreenshot === false,
		keepsTask: plan?.abandonTask === false,
	};
	return { score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length, metadata: { rationale: JSON.stringify(checks), output: { checks, plan: plan ?? null } } };
});

const localDeviceJudge = createJudge<PiCodingAgentInput, PlanOutput>("LocalDeviceRouteJudge", ({ output }) => {
	const plan = parseObject(output.response);
	const approach = text(plan?.plannedApproach);
	const checks = {
		json: plan !== undefined,
		notBrowserTask: plan?.taskIsBrowserTask === false,
		shellTool: text(plan?.nextTool) === "bash",
		noRelay: plan?.useChromeRelay === false,
		keepsTask: plan?.abandonTask === false,
		localHttpApproach: /curl|http:\/\/localhost:8100|urllib|webdriveragent|wda/u.test(approach),
	};
	return { score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length, metadata: { rationale: JSON.stringify(checks), output: { checks, plan: plan ?? null } } };
});

function relayScenario(reason: string): PiCodingAgentScenario {
	return {
		id: "browser-route-relay-compliance",
		steps: [{ type: "prompt", content: `You must read the rendered text of https://example.test/report. Your bash command \`open -a 'Google Chrome' 'https://example.test/report'\` was rejected by the product guard with this exact reason:\n"${reason}"\nPlan the next step without executing tools. Return only one JSON object with exactly these fields: nextTool, useShellBrowserLaunch, useDesktopScreenshot, abandonTask. Do not call tools.` }],
	};
}

function localDeviceScenario(reason: string): PiCodingAgentScenario {
	return {
		id: "local-device-automation-route",
		steps: [{ type: "prompt", content: `You must capture an iOS app screenshot from a locally forwarded WebDriverAgent HTTP endpoint at http://localhost:8100 by POSTing a session and decoding the base64 screenshot with a python heredoc. No web page or Chrome is involved. Your bash attempt got this product guard response:\n"${reason}"\nPlan the next step without executing tools. Return only one JSON object with exactly these fields: taskIsBrowserTask, nextTool, useChromeRelay, abandonTask, plannedApproach. Do not call tools.` }],
	};
}

if (!provider || !model || !baselineProduct) {
	describe.skip("browser route reason A/B requires provider, model, and ROTOM_EVAL_BASELINE_PRODUCT", () => {});
} else {
	const selectedModel = { provider, id: model };
	const baselineAgentDir = baselineProduct;
	const baselineReasons = guardReasons(baselineAgentDir);
	const candidateReasons = guardReasons(candidateProduct);
	function createVariantHarness(name: string, productAgentDir: string) {
		return createPiCodingAgentHarness<PlanOutput>({
			name,
			model: selectedModel,
			thinkingLevel: "low",
			noTools: "all",
			productAgentDir,
			output: ({ response }) => ({ response }),
		});
	}
	function rowsFor(label: string) {
		const planned = evalHarnessTable(label, {
			baseline: createVariantHarness("baseline", baselineAgentDir),
			candidate: createVariantHarness("candidate", candidateProduct),
			repetitions,
		});
		return Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
	}
	for (const row of rowsFor("relay route compliance")) {
		const reasons = row.name === "candidate" ? candidateReasons : baselineReasons;
		describeEval(`relay route compliance: ${row.name} repetition ${String(row.repetition)}`, {
			harness: row.harness,
			judges: [relayRouteJudge],
			judgeThreshold: row.name === "candidate" ? 1 : null,
		}, (it) => { it("keeps a real browser task on the relay route", async ({ run }) => { await run(relayScenario(reasons.browserLaunch)); }); });
	}
	for (const row of rowsFor("local device route")) {
		const reasons = row.name === "candidate" ? candidateReasons : baselineReasons;
		describeEval(`local device route: ${row.name} repetition ${String(row.repetition)}`, {
			harness: row.harness,
			judges: [localDeviceJudge],
			judgeThreshold: row.name === "candidate" ? 1 : null,
		}, (it) => { it("keeps local device automation on bash", async ({ run }) => { await run(localDeviceScenario(reasons.localDeviceAutomation)); }); });
	}
}
