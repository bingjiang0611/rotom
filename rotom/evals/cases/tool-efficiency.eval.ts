import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput, type PiCodingAgentOutputContext } from "../src/pi-harness.ts";

// Real model acceptance, explicitly opt-in. All commands operate on synthetic local fixtures.
const enabled = process.env.ROTOM_EVAL_TOOL_EFFICIENCY === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const baseline = process.env.ROTOM_EVAL_BASELINE_PRODUCT?.trim();
const candidate = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const exact = ["export function renderCounter(value) {", "  // Preserve all 110 branches, punctuation and whitespace.",
	...Array.from({ length: 110 }, (_, n) => `  if (value === ${n}) return '${n} items — total';`),
	"  return `${value}: remaining`;", "}"].join("\n");
const counterScript = `import { appendFileSync } from 'node:fs';\nappendFileSync('check-runs.txt', 'run\\n');\n`;
const limits = `export function alpha() {\n  return 2;\n}\nexport function beta() {\n  return 2;\n}\n`;
type Scenario = {
	id: string; root: string; files: Record<string, string>; changed?: Record<string, string>;
	expected: Record<string, string>; marker?: string; prompt: string; accepts: (response: string) => boolean;
	candidateOnly?: boolean; requireCompact?: boolean; driftEdit?: boolean;
};
const cases: Scenario[] = [
	{
		id: "locate-edit-verify", root: "packages/widget",
		files: {
			"launcher.txt": "This directory is a launcher workspace, not the package repository.\n",
			"packages/widget/package.json": JSON.stringify({ type: "module", scripts: { "verify:widget": "node check.mjs" } }),
			"packages/widget/src/limits.mjs": limits,
			"packages/widget/check.mjs": `${counterScript}import { alpha, beta } from './src/limits.mjs';\nfor (let i=0;i<1200;i++) console.log('PASS unrelated fixture '+i);\nif (alpha() !== 2 || beta() !== 3) { console.error('FAIL limits'); process.exit(1); }\nconsole.log('PASS alpha=2 beta=3');\n`,
		},
		expected: { "packages/widget/src/limits.mjs": limits.replace("function beta() {\n  return 2;", "function beta() {\n  return 3;") },
		marker: "packages/widget/check-runs.txt",
		prompt: "The widget project is somewhere in this launcher workspace. Set beta's return value to 3, keep alpha and all other source unchanged, using the edit tool. Discover its actual repository and package verification script, then run that script once. Report the verified alpha/beta values. Do not add scripts or commit.",
		accepts: (s: string) => /alpha[\s\S]{0,40}2/u.test(s) && /beta[\s\S]{0,40}3/u.test(s),
	},
	{
		id: "failed-check-evidence", root: ".",
		files: {
			"package.json": JSON.stringify({ type: "module", scripts: { "verify:widget": "node check.mjs" } }),
			"check.mjs": `${counterScript}for(let i=0;i<1600;i++){if(i===437)console.log('FAIL src/widget.mjs:73 EXPECTED=314 ACTUAL=271');console.log('PASS unrelated fixture '+i)}\nconsole.log('FAILED: one assertion; details above');process.exitCode=7;\n`,
		},
		expected: {}, marker: "check-runs.txt",
		prompt: "Find the package verification script and run it exactly once. Diagnose its failure using the actual output: report the source location and EXPECTED/ACTUAL values, and whether it passed. Do not modify source or rerun the check to recover missing output.",
		accepts: acceptsFailedCheckResponse,
	},
	{
		id: "exact-source", root: ".",
		files: { "src/counter.mjs": `${"// unrelated filler\n".repeat(700)}${exact}\n${"// trailing filler\n".repeat(700)}` },
		expected: {},
		prompt: "Return the complete renderCounter function from src/counter.mjs verbatim, including every branch, comment, whitespace and punctuation. Do not summarize or omit any line. Do not change files.",
		accepts: (s: string) => s.includes(exact),
	},
	{
		id: "scoped-diff", root: ".",
		files: {
			"config/routes.json": '{"production":true,"auditEnabled":true}\n',
			"generated/catalog.json": `${JSON.stringify(Array.from({length: 1800}, (_, id) => ({id, label: `old fixture ${id}`})), null, 2)}\n`,
		},
		changed: {
			"config/routes.json": '{"production":true,"auditEnabled":false}\n',
			"generated/catalog.json": `${JSON.stringify(Array.from({length: 1800}, (_, id) => ({id, label: `new fixture ${id}`})), null, 2)}\n`,
		},
		expected: {},
		prompt: "Review the current uncommitted changes. Report whether production auditing is disabled and cite the exact config change. Generated catalog labels are mechanical output, not part of the review. Do not change files or commit.",
		accepts: (s: string) => s.includes("config/routes.json") && s.includes("auditEnabled") && s.includes("false"),
	},
	{
		id: "process-projection", root: ".",
		files: { "processes.json": JSON.stringify(Array.from({length: 300}, (_, id) => ({pid: 1000 + id, group: id % 10 === 0 ? "widget" : "unrelated", cpu: id % 10 === 0 ? 2 : 1, args: `FIXTURE_ARGUMENT_NOT_NEEDED_${id} ${"padding ".repeat(50)}`}))) },
		expected: {},
		prompt: "Using the synthetic process snapshot processes.json, report only widget group process count and summed CPU as COUNT=<integer> CPU=<integer>. Do not inspect real machine processes or display process arguments. Do not change files.",
		accepts: (s: string) => /COUNT\s*=\s*30/u.test(s) && /CPU\s*=\s*60/u.test(s),
	},
];
// Capability exercises are separate from the natural paired A/B above.
cases.push(
	{ ...cases[0]!, id: "compact-success", candidateOnly: true, requireCompact: true,
		prompt: `${cases[0]!.prompt} Use bash with compact=true for the verification command. Do not redirect or pipe its output; recover any missing evidence from the tool's saved full-output path.` },
	{ ...cases[1]!, id: "compact-failure", candidateOnly: true, requireCompact: true,
		prompt: `${cases[1]!.prompt} Use bash with compact=true for the verification command. Do not redirect or pipe its output; recover missing failure details from the tool's saved full-output path.` },
	{ id: "stale-edit-recovery", root: ".", candidateOnly: true, driftEdit: true,
		files: { "settings.json": '{"alpha":2,"beta":2}\n' },
		expected: { "settings.json": '{"alpha":2,"beta":3}\n' },
		prompt: "Set beta to 3 in settings.json using the edit tool. Keep alpha and the rest of the file unchanged. If the file has changed since your read, inspect its current content and repair your edit instead of replaying stale text. Do not commit.",
		accepts: (s) => /beta[\s\S]{0,40}3/u.test(s) },
);

export function acceptsFailedCheckResponse(response: string): boolean {
	const plain = response.replaceAll(/[`*]/gu, "");
	return plain.includes("src/widget.mjs:73") && /EXPECTED\s*[=:]\s*314/iu.test(plain) && /ACTUAL\s*[=:]\s*271/iu.test(plain) && /fail|失败/iu.test(plain);
}

type Output = { correct: boolean; filesIntact: boolean; checkRuns: number | null; toolCalls: number; toolErrors: number; resultBytes: number; compactCalls: number; editRejections: number; unneededProcessArguments: boolean };
function metrics(session: PiCodingAgentOutputContext["session"]) {
	let toolCalls = 0, toolErrors = 0, resultBytes = 0, compactCalls = 0, editRejections = 0, unneededProcessArguments = false;
	for (const message of session.messages) {
		if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") {
			toolCalls++;
			if (part.name === "bash" && part.arguments.compact === true) compactCalls++;
		}
		if (message.role === "toolResult") {
			if (message.isError) toolErrors++;
			for (const part of message.content) if (part.type === "text") {
				resultBytes += Buffer.byteLength(part.text);
				if (part.text.includes("FIXTURE_ARGUMENT_NOT_NEEDED_")) unneededProcessArguments = true;
				if (message.toolName === "edit" && message.isError && part.text.includes("No edits were written by this call.")) editRejections++;
			}
		}
	}
	return { toolCalls, toolErrors, resultBytes, compactCalls, editRejections, unneededProcessArguments };
}
function git(cwd: string, args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
	if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`);
}
async function files(workspace: string, entries: Record<string, string>) {
	for (const [name, body] of Object.entries(entries)) {
		await mkdir(dirname(join(workspace, name)), { recursive: true });
		await writeFile(join(workspace, name), body);
	}
}
if (!enabled || !provider || !model || !baseline) {
	describe.skip("tool efficiency requires explicit enablement, model and baseline product", () => {});
} else {
	// Use the launcher's exact installed/archive/source identity gate, not an
	// explicit-maintenance executable that merely has the same version string.
	const executables = new Map<string, string>();
	for (const root of [baseline, candidate]) {
		const { resolveInstalledPi } = await import(pathToFileURL(join(root, "runtime/resolve-installed-pi.mjs")).href);
		executables.set(root, await resolveInstalledPi(root));
	}
	for (const scenario of cases) {
	for (const repetition of [1, 2]) for (const arm of (repetition === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"]).filter((arm) => !scenario.candidateOnly || arm === "candidate")) {
		const productAgentDir = arm === "baseline" ? baseline : candidate;
		const harness = createPiCodingAgentHarness<Output>({
			name: `${arm}-${repetition}`, productAgentDir,
			piExecutable: executables.get(productAgentDir)!,
			model: { provider, id: model }, thinkingLevel: "low", tools: ["read", "bash", "edit"],
			inlineExtensions: scenario.driftEdit ? [(pi) => {
				let changed = false;
				pi.on("tool_call", async (event, ctx) => {
					if (changed || event.toolName !== "edit" || resolve(ctx.cwd, String(event.input.path)) !== join(ctx.cwd, "settings.json")) return;
					// Deterministic external-file-change fixture. The real native edit must
					// reject stale oldText; neither its response nor the model is mocked.
					const file = join(ctx.cwd, "settings.json");
					const original = await readFile(file, "utf8");
					if (original !== scenario.files["settings.json"]) throw new Error("drift fixture changed before the first edit");
					await writeFile(file, original.replace('"beta":2', '"beta":4'));
					changed = true;
				});
			}] : [],
			async setupWorkspace({ workspace, configDir }) {
				await files(workspace, scenario.files);
				await writeFile(join(configDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
				const root = join(workspace, scenario.root);
				git(root, ["init", "--quiet"]);
				git(root, ["add", "."]);
				git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
				if (scenario.changed) await files(workspace, scenario.changed);
			},
			async output({ workspace, response, session }) {
				const expected = { ...scenario.files, ...scenario.changed, ...scenario.expected };
				const intact = await Promise.all(Object.entries(expected).map(async ([name, body]) => (await readFile(join(workspace, name), "utf8")) === body));
				let checkRuns: number | null = null;
				if (scenario.marker) {
					try { checkRuns = (await readFile(join(workspace, scenario.marker), "utf8")).trim().split("\n").length; }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; checkRuns = 0; }
				}
				return { correct: scenario.accepts(response), filesIntact: intact.every(Boolean), checkRuns, ...metrics(session) };
			},
		});
		describeEval(`Tool efficiency ${scenario.id}: ${arm} repetition ${repetition}`, {
			harness, judges: [createJudge<PiCodingAgentInput, Output>(scenario.id, ({ output }) => ({
				score: output.correct && output.filesIntact && (output.checkRuns === null || output.checkRuns === 1) && !output.unneededProcessArguments
					&& (!scenario.requireCompact || output.compactCalls > 0) && (!scenario.driftEdit || output.editRejections === 1) ? 1 : 0,
				metadata: { output },
			}))], judgeThreshold: 1,
		}, (it) => { it(scenario.id, async ({ run }) => { await run(scenario.prompt); }); });
	}
}
}
