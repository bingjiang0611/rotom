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
const repetitions = Number(process.env.ROTOM_EVAL_REPEATS ?? "2");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_REPEATS must be an integer from 1 to 5.");

type Output = { response: string };
type RecordValue = Record<string, JsonValue>;
function parseObject(response: string): RecordValue | undefined { const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? response; const start = fenced.indexOf("{"); const end = fenced.lastIndexOf("}"); if (start < 0 || end <= start) return undefined; try { const parsed = JSON.parse(fenced.slice(start, end + 1)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RecordValue : undefined; } catch { return undefined; } }
function text(value: JsonValue | undefined): string { return typeof value === "string" ? value.toLowerCase() : ""; }
function bool(value: JsonValue | undefined): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function object(value: JsonValue | undefined): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function judge(name: string, checks: (plan: RecordValue | undefined) => Record<string, boolean>) { return createJudge<PiCodingAgentInput, Output>(name, ({ output }) => { const plan = parseObject(output.response); const result = { json: plan !== undefined, ...checks(plan) }; return { score: Object.values(result).filter(Boolean).length / Object.keys(result).length, metadata: { rationale: JSON.stringify(result), output: { result, plan: plan ?? null } } }; }); }

const cases = [
	{
		label: "canvas coordinate fallback",
		scenario: { id: "browser-coordinate-canvas", steps: [{ type: "prompt", content: "Plan but do not execute the next browser action. A Canvas control is visible in the latest browser_inspect screenshot at CSS viewport point x=420,y=260. The screenshot metadata has observationEpoch=17 and no usable AX targetRef exists. Return only JSON with fields nextTool, arguments (object), usesSystemMouse, requiresPreDispatchHitTest." }] } satisfies PiCodingAgentScenario,
		judge: judge("BrowserCoordinateCanvasJudge", (plan) => { const args = object(plan?.arguments); return { browserInteract: text(plan?.nextTool) === "browser_interact", click: text(args.action) === "click", coordinates: Number(args.x) === 420 && Number(args.y) === 260, epoch: Number(args.observationEpoch) === 17, noRef: args.targetRef === undefined || args.targetRef === null || text(args.targetRef) === "", noSystemMouse: bool(plan?.usesSystemMouse) === false, hitTest: bool(plan?.requiresPreDispatchHitTest) === true }; }),
	},
	{
		label: "stale screenshot rejection",
		scenario: { id: "browser-coordinate-stale", steps: [{ type: "prompt", content: "A screenshot had observationEpoch=17, but a later snapshot_visible returned observationEpoch=18 before any coordinate click. Plan without executing tools. Return only JSON with fields nextTool, recaptureScreenshot, useEpoch, clickWithOldCoordinates." }] } satisfies PiCodingAgentScenario,
		judge: judge("BrowserCoordinateStaleJudge", (plan) => ({ inspect: text(plan?.nextTool).startsWith("browser_inspect"), recapture: bool(plan?.recaptureScreenshot) === true, noOldEpoch: Number(plan?.useEpoch) !== 17, noOldClick: bool(plan?.clickWithOldCoordinates) === false })),
	},
	{
		label: "ref click remains preferred",
		scenario: { id: "browser-ref-preferred", steps: [{ type: "prompt", content: "Plan but do not execute. snapshot_visible exposes a current button targetRef ax_4_91. A screenshot is also available. Return only JSON with fields nextTool, arguments (object), coordinateFallbackUsed." }] } satisfies PiCodingAgentScenario,
		judge: judge("BrowserRefPreferredJudge", (plan) => { const args = object(plan?.arguments); return { browserInteract: text(plan?.nextTool) === "browser_interact", click: text(args.action) === "click", currentRef: text(args.targetRef) === "ax_4_91", noCoordinates: args.x === undefined && args.y === undefined && args.observationEpoch === undefined, noFallback: bool(plan?.coordinateFallbackUsed) === false }; }),
	},
	{
		label: "hit-test mismatch fails closed",
		scenario: { id: "browser-coordinate-hit-mismatch", steps: [{ type: "prompt", content: "A coordinate click failed before dispatch because the DOM hit-test target changed after the screenshot. Plan without executing tools. Return only JSON with fields dispatchAgainImmediately, nextTool, useSystemMouseFallback, maximumOldCoordinateRetries." }] } satisfies PiCodingAgentScenario,
		judge: judge("BrowserCoordinateHitMismatchJudge", (plan) => ({ noImmediateReplay: bool(plan?.dispatchAgainImmediately) === false, rescreenshot: text(plan?.nextTool).startsWith("browser_inspect"), noSystemMouse: bool(plan?.useSystemMouseFallback) === false, noOldRetry: Number(plan?.maximumOldCoordinateRetries) === 0 })),
	},
] as const;

if (!provider || !model || !baselineProduct) {
	describe.skip("browser coordinate click A/B requires provider, model, and ROTOM_EVAL_BASELINE_PRODUCT", () => {});
} else {
	const selectedModel = { provider, id: model };
	const baselineProductPath = baselineProduct;
	function harness(name: string, productAgentDir: string) { return createPiCodingAgentHarness<Output>({ name, model: selectedModel, thinkingLevel: "low", tools: ["browser_inspect", "browser_interact"], productAgentDir, output: ({ response }) => ({ response }) }); }
	function rows(label: string) { const planned = evalHarnessTable(label, { baseline: harness("baseline", baselineProductPath), candidate: harness("candidate", candidateProduct), repetitions }); return Array.from({ length: repetitions }, (_, index) => { const repeated = planned.filter(({ repetition }) => repetition === index + 1); return index % 2 === 0 ? repeated : [...repeated].reverse(); }).flat(); }
	for (const item of cases) for (const row of rows(item.label)) describeEval(`${item.label}: ${row.name} repetition ${String(row.repetition)}`, { harness: row.harness, judges: [item.judge], judgeThreshold: row.name === "candidate" ? 1 : null }, (it) => { it(item.label, async ({ run }) => { await run(item.scenario); }); });
}
