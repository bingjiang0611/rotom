import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createPiCodingAgentHarness, type PiCodingAgentHarnessOptions, type PiCodingAgentScenario } from "./pi-harness.ts";
import { createReplayMetrics, readOffloadDecisions, type OffloadDecision } from "./compaction-offload-metrics.ts";
import type { ReplayAuthorization } from "./compaction-offload-budget.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// 04b consumed its one campaign. A new written authorization is required;
// the old receipt stays intact and must not be bypassed with a fresh directory.
export const LIVE_AUTHORIZATION: Readonly<ReplayAuthorization> | null = null;

export const REPLAY_PRODUCT = resolve(import.meta.dirname, "../..");
export const REPLAY_THRESHOLD = 64_000;
export const coverageNudgePrompt = (remaining: number) => `Audit phase is not complete: ${remaining} listed files have not been read yet. Continue reading the remaining files from manifest.json individually, then reply READY.`;
// Match the production retained-tail fraction, not the candidate's target.
export const REPLAY_KEEP_RECENT = Math.round(REPLAY_THRESHOLD * 0.08);
export const LIVE_REPLAY_TIMEOUT_MS = 30 * 60_000;
export const REPLAY_TOOLS = ["read", "edit", "write", "obs_recall"];
// Removing bash alone leaves Action Fusion's edit/write then_run shell path open.
export const REPLAY_CONFIG = Object.freeze({ version: 1, actionFusion: false, observationPack: true, evidencePreservingReducer: false, onlineContextCompact: false });
export const EXACT_CODE = createHash("sha256").update("synthetic-offload-replay-exact-detail-v1").digest("hex").slice(0, 40);

function padded(key: string, body: string) {
	let seed = createHash("sha256").update(`replay-v2/${key}`).digest().readUInt32LE(0);
	const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
	const code = key.startsWith("module-") || key.startsWith("src/");
	const lines: string[] = [];
	let bytes = Buffer.byteLength(body) + 1;
	while (bytes < 3072) {
		const i = lines.length, worker = next() % 32, duration = next() % 900, count = next() % 10000;
		const line = i % 3 === 0
			? `2026-01-15T12:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${worker} processed audit batch ${count}; duration_ms=${duration}; status=ok`
			: i % 3 === 1
				? JSON.stringify({ component: key, batch: count, worker, durationMs: duration, retries: i % 4, cache: i % 2 ? "hit" : "miss" })
				: `const checkpoint${i} = { accepted: ${count}, elapsed: ${duration}, worker: ${worker} }; // Validate before reporting the result.`;
		const formatted = code ? `// ${line}` : line;
		const lineBytes = Buffer.byteLength(formatted) + 1;
		if (bytes + lineBytes > 3072) break;
		lines.push(formatted); bytes += lineBytes;
	}
	lines.splice(Math.floor(lines.length / 2), 0, body);
	return `${lines.join("\n")}\n`;
}
const background = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`notes/note-${i}.txt`, padded(`note-${i}`, `// Synthetic audit note ${i}; no executable behavior.`)]));
const modules = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`modules/module-${i}.mjs`, padded(`module-${i}`, `export const VALUE = ${(i + 1) * 17};`)]));
const sum = [2, 7, 13, 19].reduce((n, i) => n + (i + 1) * 17, 0);
const summary = (n: number) => `export const total = ${n};\nexport const untouched = "synthetic stable suffix";\n`;
const fixes = { "src/add.mjs": "export const add = (a, b) => a + b;", "src/scale.mjs": "export const scale = (n) => n * 3;", "src/label.mjs": "export const label = (n) => `value:${n}`;" };
const bugs = { "src/add.mjs": "export const add = (a, b) => a - b;", "src/scale.mjs": "export const scale = (n) => n * 2;", "src/label.mjs": "export const label = (n) => `value=${n}`;" };
const fixFiles = Object.fromEntries(Object.entries(fixes).map(([path, body]) => [path, padded(path, body)]));
const failureLog = padded("synthetic failure diagnostics", "// Check the three exported functions against the assertions below.").slice(0, 2400);
const testScript = `import assert from 'node:assert/strict';
import { add } from './src/add.mjs';
import { scale } from './src/scale.mjs';
import { label } from './src/label.mjs';
try {
  for (const n of [-5, 0, 1, 17, 103]) {
    assert.equal(add(n, 4), n + 4);
    assert.equal(scale(n), n * 3);
    assert.equal(label(n), 'value:' + n);
  }
  console.log('PASS');
} catch (error) { console.error(${JSON.stringify(failureLog)}); console.error(error.message); process.exitCode = 1; }
`;

export type ReplayTask = {
	id: string; files: Readonly<Record<string, string>>; reading: readonly string[];
	answer: string; solution: Readonly<Record<string, string>>; check?: string; scenario: PiCodingAgentScenario;
};
function task(id: string, files: Record<string, string>, finish: string, answer: string, solution: Record<string, string>, check?: string): ReplayTask {
	const reading = Object.keys(files).filter((path) => path.startsWith("modules/") || path.startsWith("notes/") || path.startsWith("src/") || path.startsWith("logs/"));
	files["manifest.json"] = JSON.stringify(reading, null, 2);
	return Object.freeze<ReplayTask>({ id, files: Object.freeze(files), reading: Object.freeze(reading), answer, solution: Object.freeze(solution), check,
		scenario: { id, steps: [
			{ type: "prompt", content: `First audit phase: read manifest.json, then read every listed file individually, in order, without editing files. ${check === "test.mjs" ? "Read logs/test-output.txt to understand the failures. " : ""}Do not skip middle sections. When finished reply READY. A separate follow-up will specify the final deliverable.` },
			{ type: "prompt", content: finish },
		] } });
}
export const REPLAY_TASKS: readonly ReplayTask[] = Object.freeze([
	task("config-aggregate", { ...modules, ...background, "summary.mjs": summary(0),
		"check.mjs": `import assert from 'node:assert/strict'; import { total, untouched } from './summary.mjs'; assert.equal(total, ${sum}); assert.equal(untouched, 'synthetic stable suffix'); console.log('PASS');\n` },
		"Set total in summary.mjs to the sum of VALUE from modules 2, 7, 13 and 19. Preserve every other byte and file. When finished reply DONE.", "DONE", { "summary.mjs": summary(sum) }, "check.mjs"),
	task("deferred-exact", { ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`logs/log-${i}.txt`, padded(`log-${i}`, i === 0 ? `EXACT_CODE=${EXACT_CODE}` : `EVENT_CODE=synthetic-${i}`)])), ...background },
		"Return only the exact 40-character EXACT_CODE from logs/log-0.txt. Do not change files or add explanations.", EXACT_CODE, {}),
	task("multi-file-fix", { ...Object.fromEntries(Object.entries(bugs).map(([path, body]) => [path, padded(path, body)])),
		...Object.fromEntries(Object.entries(modules).slice(0, 17)), ...background, "test.mjs": testScript,
		"logs/test-output.txt": `${failureLog}\nFailing test expectations for n in [-5, 0, 1, 17, 103]:\nassert.equal(add(n, 4), n + 4);\nassert.equal(scale(n), n * 3);\nassert.equal(label(n), 'value:' + n);\n` },
		"Repair add, scale and label to satisfy the assertions in logs/test-output.txt. Preserve comments and all other files, especially test.mjs. When finished reply DONE.", "DONE", fixFiles, "test.mjs"),
]);

export async function writeReplayFixture(workspace: string, selected: ReplayTask) {
	for (const [path, content] of Object.entries(selected.files)) {
		await mkdir(dirname(join(workspace, path)), { recursive: true });
		await writeFile(join(workspace, path), content);
	}
}
export async function gradeReplay(selected: ReplayTask, workspace: string, response: string): Promise<boolean> {
	if (response.trim() !== selected.answer) return false;
	for (const [path, original] of Object.entries(selected.files)) {
		let actual: string;
		try { actual = await readFile(join(workspace, path), "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
		if (selected.id === "multi-file-fix" && path in selected.solution) {
			// The checker, not a reference patch's spelling, decides repair correctness.
			const comments = (source: string) => source.split("\n").filter((line) => line.startsWith("//")).join("\n");
			if (comments(actual) !== comments(original)) return false;
		} else if (actual !== (selected.solution[path] ?? original)) return false;
	}
	return !selected.check || spawnSync(process.execPath, [selected.check], { cwd: workspace, timeout: 5000 }).status === 0;
}

export function createReplayHarness(selected: ReplayTask, candidate: boolean, options: Required<Pick<PiCodingAgentHarnessOptions, "model" | "modelRuntimeFactory">> & Pick<PiCodingAgentHarnessOptions, "piExecutable" | "thinkingLevel">) {
	const metrics = createReplayMetrics(undefined, Object.fromEntries(selected.reading.map((path) => [path, selected.files[path]!])));
	let lastBranch: SessionEntry[] | undefined;
	let offloadDecisions: OffloadDecision[] = [];
	let hasPricing = false;
	const harness = createPiCodingAgentHarness({
		...options, name: candidate ? "candidate" : "baseline", productAgentDir: REPLAY_PRODUCT,
		piExecutable: options.piExecutable ?? resolve(REPLAY_PRODUCT, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
		thinkingLevel: options.thinkingLevel ?? "off", tools: [...REPLAY_TOOLS],
		inlineExtensions: [metrics.extension, (pi) => {
			pi.on("session_shutdown", async (_event, ctx) => {
				lastBranch = ctx.sessionManager.getBranch();
				offloadDecisions = await readOffloadDecisions(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
			});
		}], inlineExtensionsFirst: true,
		environment: { ROTOM_COMPACTION_OFFLOAD: candidate ? "1" : "0", PI_CODING_AGENT_DIR: undefined },
		async setupWorkspace({ workspace, configDir }) {
			// Executed inside the harness's exclusive/restoring environment scope.
			process.env.PI_CODING_AGENT_DIR = configDir;
			await writeFile(join(configDir, "sol-pi.json"), JSON.stringify(REPLAY_CONFIG));
			await writeReplayFixture(workspace, selected);
		},
		continuePrompt({ session, stepIndex }) {
			if (stepIndex !== 0) return;
			const snapshot = metrics.output(session.sessionManager.getBranch(), false, false);
			const remaining = snapshot.phase1Coverage.totalFiles - snapshot.phase1Coverage.readFiles;
			if (remaining === 0 || snapshot.coverageNudges >= 2) return;
			metrics.recordCoverageNudge();
			return coverageNudgePrompt(remaining);
		},
		async modelRuntimeFactory(context) {
			const runtime = await options.modelRuntimeFactory(context);
			const model = runtime.getModel(options.model.provider, options.model.id);
			if (!model || model.contextWindow <= REPLAY_THRESHOLD) throw new Error("Replay model must have a window greater than the fixed threshold");
			await writeFile(join(context.configDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: model.contextWindow - REPLAY_THRESHOLD, keepRecentTokens: REPLAY_KEEP_RECENT } }));
			return runtime;
		},
		async output({ session, workspace, response }) {
			const correct = await gradeReplay(selected, workspace, response);
			const cost = session.model?.cost;
			hasPricing = !!cost && Object.values(cost).some((n) => typeof n === "number" && n > 0);
			offloadDecisions = await readOffloadDecisions(session.sessionManager.getSessionDir(), session.sessionManager.getSessionId());
			return metrics.output(session.sessionManager.getBranch(), correct, hasPricing, offloadDecisions);
		},
	});
	const run: typeof harness.run = async (input, context) => {
		const started = performance.now();
		lastBranch = undefined;
		offloadDecisions = [];
		hasPricing = false;
		const result = await harness.run(input, context);
		// Include workspace/loader setup, grading, shutdown and artifact capture.
		return { ...result, output: { ...result.output, wallMs: performance.now() - started } };
	};
	return { ...harness, run,
		failureMetrics: () => lastBranch ? metrics.output(lastBranch, false, hasPricing, offloadDecisions) : null,
	};
}
