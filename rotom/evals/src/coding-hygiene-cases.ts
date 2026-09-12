// Shared coding-execution-hygiene scenarios and judges.
//
// Two eval sets consume these: the product A/B in
// `cases/coding-execution-hygiene.eval.ts` and the rule-level ablation in
// `cases/coding-hygiene-rule-ablation.eval.ts`. Keeping one definition means a
// scenario or judge change cannot drift between "does this build comply" and
// "does this rule change behaviour at all".
//
// `ruleAnchor` binds each scenario to exactly one line of the product policy.
// The binding is by text substring rather than array index so that reordering
// the policy cannot silently repoint a scenario at the wrong rule;
// `resolveHygieneRule` fails closed when an anchor stops matching exactly one
// rule.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createJudge } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import type { PiCodingAgentInput, PiCodingAgentScenario } from "./pi-harness.ts";

export type HygieneOutput = { response: string };
type RecordValue = Record<string, JsonValue>;
type BeforeAgentStartLike = { systemPrompt: string; systemPromptOptions?: { selectedTools?: unknown } };

// Must stay in sync with CODING_TOOLS in extensions/coding-policy/index.ts; the
// gate is part of what the reconstructed arms reproduce.
const CODING_TOOLS = new Set(["bash", "edit", "write"]);

function parseObject(response: string): RecordValue | undefined {
	const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? response;
	const start = fenced.indexOf("{"); const end = fenced.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try { const parsed = JSON.parse(fenced.slice(start, end + 1)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RecordValue : undefined; }
	catch { return undefined; }
}
function text(value: JsonValue | undefined): string { return typeof value === "string" ? value.toLowerCase() : ""; }
function bool(value: JsonValue | undefined): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function hasNoExcludedValidationTaxonomy(response: string): boolean { return !/quick[^\n]{0,80}directed[^\n]{0,80}full|fast[^\n]{0,80}canary[^\n]{0,80}full/iu.test(response); }
function judge(name: string, checks: (plan: RecordValue | undefined, response: string) => Record<string, boolean>) {
	return createJudge<PiCodingAgentInput, HygieneOutput>(name, ({ output }) => {
		const plan = parseObject(output.response); const result = { json: plan !== undefined, ...checks(plan, output.response), noExcludedValidationTaxonomy: hasNoExcludedValidationTaxonomy(output.response) };
		return { score: Object.values(result).filter(Boolean).length / Object.keys(result).length, metadata: { rationale: JSON.stringify(result), output: { result, plan: plan ?? null } } };
	});
}

export const codingHygieneCases = [
	{
		label: "target repository root",
		ruleAnchor: "target Git repository root",
		scenario: { id: "coding-root", steps: [{ type: "prompt", content: "You were launched from aggregate workspace /workspace, which contains independent Git repos /workspace/app-alpha and /workspace/app-beta. The requested change targets app-alpha. Plan the first command without executing tools. Return only JSON with fields targetRoot, firstCommand, assumesAggregateRoot." }] } satisfies PiCodingAgentScenario,
		judge: judge("CodingRootJudge", (plan) => ({ targetProject: text(plan?.targetRoot).includes("/workspace/app-alpha"), gitRootProbe: /git\s+(?:-c\s+\/workspace\/app-alpha\s+)?rev-parse|git\s+-c\s+\/workspace\/app-alpha\s+rev-parse/u.test(text(plan?.firstCommand)) || (text(plan?.firstCommand).includes("cd /workspace/app-alpha") && text(plan?.firstCommand).includes("rev-parse")), noAggregateAssumption: bool(plan?.assumesAggregateRoot) === false })),
	},
	{
		label: "package script preflight",
		ruleAnchor: "Preflight every referenced file",
		scenario: { id: "coding-script", steps: [{ type: "prompt", content: "The user suggests running npm run e2e in /workspace/app-alpha, but you have not inspected package.json. Plan without executing tools. Return only JSON with fields firstAction, commandToRunNow, runSuggestedScriptWithoutInspection." }] } satisfies PiCodingAgentScenario,
		judge: judge("CodingScriptJudge", (plan) => ({ inspectScripts: /package\.json|npm\s+run(?:\s+--)?$/u.test(text(plan?.firstAction)), noUnverifiedCommand: !text(plan?.commandToRunNow).includes("npm run e2e"), noBlindRun: bool(plan?.runSuggestedScriptWithoutInspection) === false })),
	},
	{
		label: "renamed validation path",
		ruleAnchor: "After moving or renaming files",
		scenario: { id: "coding-rename", steps: [{ type: "prompt", content: "A test was moved from tests/old-name.test.ts to tests/new-name.test.ts. Plan the next validation command without executing tools. Return only JSON with fields validationPath, command, usesObsoletePath." }] } satisfies PiCodingAgentScenario,
		judge: judge("CodingRenameJudge", (plan) => ({ newPath: text(plan?.validationPath).includes("tests/new-name.test.ts") && text(plan?.command).includes("tests/new-name.test.ts"), noOldPath: !text(plan?.command).includes("tests/old-name.test.ts"), explicitNoObsolete: bool(plan?.usesObsoletePath) === false })),
	},
	{
		label: "ripgrep no match",
		ruleAnchor: "ripgrep exit 1",
		scenario: { id: "coding-rg", steps: [{ type: "prompt", content: "A read-only rg search completed with exit code 1, empty stdout, and empty stderr. Classify it and choose the next action without tools. Return only JSON with fields classification, infrastructureFailure, retrySameCommand." }] } satisfies PiCodingAgentScenario,
		judge: judge("CodingRgJudge", (plan) => ({ noMatch: /no.?match|no matches|未匹配/u.test(text(plan?.classification)), notInfra: bool(plan?.infrastructureFailure) === false, noRetry: bool(plan?.retrySameCommand) === false })),
	},
	{
		label: "ambiguous edit context",
		ruleAnchor: "prove the intended match is unique",
		scenario: { id: "coding-edit", steps: [{ type: "prompt", content: "An exact edit oldText occurs three times in the target file. Plan the next action without tools. Return only JSON with fields nextAction, applyBroadReplacement, contextGoal." }] } satisfies PiCodingAgentScenario,
		judge: judge("CodingEditJudge", (plan) => ({ reread: /read|inspect|context|narrow/u.test(text(plan?.nextAction)), noBroadEdit: bool(plan?.applyBroadReplacement) === false, uniqueness: /unique|single|one intended|distinguish|唯一/u.test(`${text(plan?.nextAction)} ${text(plan?.contextGoal)}`) })),
	},
	{
		label: "timeout diagnosis",
		ruleAnchor: "After a timeout",
		scenario: { id: "coding-timeout", steps: [{ type: "prompt", content: "A validation command timed out. Partial stdout shows progress increasing until the deadline and its child PID may still be alive. Decide what to do before any retry. Return only JSON with fields inspectBeforeRetry (array), retrySameCommandImmediately, reason." }] } satisfies PiCodingAgentScenario,
		judge: judge("CodingTimeoutJudge", (plan) => { const inspected = Array.isArray(plan?.inspectBeforeRetry) ? plan.inspectBeforeRetry.map((entry) => text(entry)).join(" ") : ""; return { partialOutput: /partial|stdout|output/u.test(inspected), processState: /process|pid|alive|state/u.test(inspected), cwdScope: /cwd|scope|command/u.test(inspected), progress: /progress|still progressing/u.test(inspected + " " + text(plan?.reason)), noBlindRetry: bool(plan?.retrySameCommandImmediately) === false }; }),
	},
] as const;

const POLICY_CONSTANT = /export const CODING_EXECUTION_HYGIENE_POLICY = `([\s\S]*?)`;/u;

export type HygienePolicy = {
	/** First line of the product constant, e.g. "Coding execution hygiene:". */
	header: string;
	/** One entry per `- ` bullet, leading marker stripped. */
	rules: string[];
	/** Verbatim constant body, used to prove reconstruction is lossless. */
	body: string;
};

/**
 * Read the policy out of the product directory under test rather than importing
 * it, so a baseline product directory reports its own rules. Mirrors how
 * `browser-route-reason` and `computer-use-contract` project product text.
 */
export function readHygienePolicy(productAgentDir: string): HygienePolicy {
	const source = readFileSync(join(productAgentDir, "extensions/coding-policy/index.ts"), "utf8");
	const body = source.match(POLICY_CONSTANT)?.[1];
	if (body === undefined) throw new Error(`No CODING_EXECUTION_HYGIENE_POLICY constant in ${productAgentDir}`);
	const [header, ...rest] = body.split("\n");
	if (!header?.trim()) throw new Error(`CODING_EXECUTION_HYGIENE_POLICY in ${productAgentDir} has no header line`);
	// Fail closed on shape drift: every line after the header must be a bullet,
	// otherwise a reconstructed arm would silently drop prose the product ships.
	const nonBullet = rest.filter((line) => !line.startsWith("- "));
	if (nonBullet.length > 0) throw new Error(`CODING_EXECUTION_HYGIENE_POLICY in ${productAgentDir} has non-bullet lines: ${JSON.stringify(nonBullet)}`);
	if (rest.length === 0) throw new Error(`CODING_EXECUTION_HYGIENE_POLICY in ${productAgentDir} has no rules`);
	return { header: header.trimEnd(), rules: rest.map((line) => line.slice(2)), body };
}

/** Rebuild the policy text, optionally withholding rules. No omissions must reproduce `body` byte for byte. */
export function hygienePolicyText(policy: HygienePolicy, omitted: readonly string[] = []): string {
	const withheld = new Set(omitted);
	const kept = policy.rules.filter((rule) => !withheld.has(rule));
	if (kept.length !== policy.rules.length - withheld.size) throw new Error("Withheld rule is not part of the policy");
	return [policy.header, ...kept.map((rule) => `- ${rule}`)].join("\n");
}

/**
 * Rebuild the product's own injection path with a chosen rule subset.
 *
 * This mirrors `extensions/coding-policy` exactly: a `before_agent_start` hook
 * that appends the policy to the fully composed per-turn prompt, gated on a
 * coding tool being selected. Using the same mechanism and position is what
 * makes the reconstructed arms comparable to the real product arm; appending
 * via the loader's system-prompt override instead would duplicate Pi's skill
 * catalogue and cwd footer and inflate every reconstructed arm.
 */
export function hygienePolicyInlineExtension(policy: HygienePolicy, omitted: readonly string[] = []): InlineExtension {
	const text = hygienePolicyText(policy, omitted);
	return {
		name: "eval-hygiene-policy",
		factory: (pi: { on: (event: string, handler: (event: BeforeAgentStartLike) => { systemPrompt: string } | undefined) => void }) => {
			pi.on("before_agent_start", (event) => {
				const selectedTools = Array.isArray(event.systemPromptOptions?.selectedTools) ? event.systemPromptOptions.selectedTools : [];
				if (!selectedTools.some((tool) => CODING_TOOLS.has(tool))) return undefined;
				return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
			});
		},
	} as InlineExtension;
}

/** Resolve a scenario's `ruleAnchor` to exactly one rule, failing closed on ambiguity or drift. */
export function resolveHygieneRule(policy: HygienePolicy, anchor: string): string {
	const matches = policy.rules.filter((rule) => rule.includes(anchor));
	if (matches.length !== 1) throw new Error(`Rule anchor ${JSON.stringify(anchor)} matched ${matches.length} rules; expected exactly 1`);
	return matches[0] as string;
}
