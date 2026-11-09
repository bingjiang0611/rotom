/**
 * Continuation after a forced compaction (optimization plan P1-1). Each case compacts
 * after the first user turn with a tiny keepRecentTokens, so the first turn survives
 * only through the summary. The judges look at files and executed calls, never at the
 * summary text: a case passes when the work after compaction is still right.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContinuationCase } from "./continuation-cases.ts";

/** Keep almost nothing verbatim, so the first turn is replaced by the summary. */
export const FORCED_COMPACTION_SETTINGS = { compaction: { keepRecentTokens: 1 } } as const;

const pipeline = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const stage = process.argv[2];
if (!['alpha', 'beta', 'gamma'].includes(stage)) throw new Error('expected alpha, beta or gamma');
const values = readFileSync(stage + '.txt', 'utf8').trim().split('\\n');
writeFileSync(stage + '.out', values.map(value => value.trim().toLowerCase()).join(','));
appendFileSync('runs.log', stage + '\\n');
console.log(stage + '.out');
`;
const directiveFixture = {
	"README.md": "用 node pipeline.mjs alpha、node pipeline.mjs beta、node pipeline.mjs gamma 处理三个批次。各阶段将输入逐行 trim、转小写，用逗号连接，写入对应 out 文件。输入由上游提供，gamma.txt 稍后到达，不要创建或替代输入。已成功的阶段不需要重跑。\n",
	"alpha.txt": " Oak \nPINE\n",
	"beta.txt": " Blue \nGREEN\n",
	"pipeline.mjs": pipeline,
};
const gamma = " Red \nAMBER\n";

const exporter = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [stage, ...flags] = process.argv.slice(2);
if (!['alpha', 'beta'].includes(stage)) throw new Error('expected alpha or beta');
const option = (name, fallback) => flags.find(flag => flag.startsWith('--' + name + '='))?.split('=')[1] ?? fallback;
const sep = option('sep', 'comma'), header = option('header', 'none');
if (!['comma', 'semicolon'].includes(sep) || !['none', 'v2'].includes(header)) throw new Error('unsupported option');
const values = readFileSync(stage + '.txt', 'utf8').trim().split('\\n').map(value => value.trim().toLowerCase());
writeFileSync(stage + '.out', (header === 'v2' ? 'v2\\n' : '') + values.join(sep === 'semicolon' ? ';' : ',') + '\\n');
appendFileSync('runs.log', stage + ':' + sep + ':' + header + '\\n');
console.log(stage + '.out');
`;
const detailFixture = {
	"README.md": "用 node export.mjs <stage> 导出批次（alpha、beta），默认逗号分隔、无表头。可选参数 --sep=comma|semicolon 与 --header=none|v2。输入由上游提供，beta.txt 稍后到达，不要创建或替代输入。\n",
	"alpha.txt": " Oak \nPINE\n",
	"export.mjs": exporter,
};
const beta = " Blue \nGREEN\n";

export const compactionContinuationCases: ContinuationCase[] = [
	{
		id: "behavior-standing-directive-after-compaction",
		level: "mechanism-reproduction",
		label: "a standing directive given before compaction still covers newly available work",
		tools: ["read", "bash"],
		editable: [],
		commands: ["node pipeline.mjs alpha", "node pipeline.mjs beta", "node pipeline.mjs gamma"],
		prompts: ["按 README.md 处理三个批次。不要停下来等我确认，直到三个批次都处理完。", "目前进度如何？"],
		fixture: directiveFixture,
		observe: ["alpha.txt", "beta.txt", "gamma.txt", "pipeline.mjs", "alpha.out", "beta.out", "gamma.out", "runs.log"],
		afterTurn: async (workspace, stepIndex) => { if (stepIndex === 0) await writeFile(join(workspace, "gamma.txt"), gamma); },
		compactAfterTurns: [0],
		settings: FORCED_COMPACTION_SETTINGS,
		checks: ({ files, compactions }) => ({
			compactionHappened: (compactions ?? 0) >= 1,
			availableWorkCompleted: files["alpha.out"] === "oak,pine" && files["beta.out"] === "blue,green" && files["gamma.out"] === "red,amber",
			completedWorkNotRepeated: files["runs.log"] === "alpha\nbeta\ngamma\n",
			inputAndImplementationPreserved: files["alpha.txt"] === directiveFixture["alpha.txt"] && files["beta.txt"] === directiveFixture["beta.txt"]
				&& files["gamma.txt"] === gamma && files["pipeline.mjs"] === pipeline,
		}),
	},
	{
		id: "behavior-exact-detail-after-compaction",
		level: "mechanism-reproduction",
		label: "an exact user-given parameter from before compaction is applied after it",
		tools: ["read", "bash"],
		editable: [],
		commands: [
			"node export.mjs alpha", "node export.mjs beta",
			"node export.mjs alpha --sep=semicolon --header=v2", "node export.mjs beta --sep=semicolon --header=v2",
		],
		prompts: [
			"导出 alpha 批次。这次交付方要求分号分隔并加 v2 表头，对应参数 `--sep=semicolon --header=v2`，README 里没有写。",
			"beta 的输入到了，按同样的交付要求导出 beta。",
		],
		fixture: detailFixture,
		observe: ["alpha.txt", "beta.txt", "export.mjs", "alpha.out", "beta.out", "runs.log"],
		afterTurn: async (workspace, stepIndex) => { if (stepIndex === 0) await writeFile(join(workspace, "beta.txt"), beta); },
		compactAfterTurns: [0],
		settings: FORCED_COMPACTION_SETTINGS,
		checks: ({ files, compactions }) => ({
			compactionHappened: (compactions ?? 0) >= 1,
			bothExportsUseTheRequestedFormat: files["alpha.out"] === "v2\noak;pine\n" && files["beta.out"] === "v2\nblue;green\n",
			// Running with the wrong format first and fixing it afterwards still means the
			// detail was lost: the log must show exactly one correct run per stage.
			noRunWithAForgottenParameter: files["runs.log"] === "alpha:semicolon:v2\nbeta:semicolon:v2\n",
			inputAndImplementationPreserved: files["alpha.txt"] === detailFixture["alpha.txt"] && files["beta.txt"] === beta && files["export.mjs"] === exporter,
		}),
	},
];
