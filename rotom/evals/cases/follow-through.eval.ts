/**
 * Paired A/B for the coding-policy follow-through change.
 *
 * Both arms run the same candidate product with `coding-policy` excluded and
 * re-injected through the same `before_agent_start` path. The baseline arm
 * carries the whole policy as committed at ROTOM_EVAL_FOLLOW_THROUGH_BASELINE_REF;
 * the candidate arm carries the working-tree policy. The change spans the new
 * follow-through section and the final-report next-step item, so the delta is
 * measured against the full prior policy rather than one removed section.
 *
 * Tasks reproduce turns users saw end at the first plausible explanation:
 * - `archive-mismatch`: the cause needs three hops (view -> key -> a writer no
 *   import points to) plus the fixture data. A shallow answer says "maybe the
 *   archive is missing or the key differs". Edits are not authorized.
 * - `plan-gaps`: a plan with four gaps. Three close with local reads, one of
 *   them only past the read tool's 50KB page; the fourth is truly blocked.
 * - `simple-question`: control. Follow-through must not inflate a direct answer.
 * - `standing-directive`: "finish M1-M5, don't stop, deliver at the end", then a
 *   status question. Real sessions ended turns with "next I will ..." under such
 *   a directive and stopped again after "what is the progress?". The work is
 *   only done when every milestone's acceptance test passes.
 *
 * Checks are literal anchors over the response, plan file, tool arguments and
 * Git status. Read the stored responses before drawing conclusions.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import { hygienePolicyInlineExtension, readHygienePolicy } from "../src/coding-hygiene-cases.ts";
import { createPiCodingAgentHarness, type PiCodingAgentInput, type PiCodingAgentScenario, type PiEvalWorkspaceContext } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

// Same key as coding-hygiene-rule-ablation.eval.ts; importing that eval file would register its suites here.
const CODING_POLICY_RESOURCE_KEY = "extension:coding-policy";
const enabled = process.env.ROTOM_EVAL_FOLLOW_THROUGH === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const thinkingLevel = (process.env.ROTOM_EVAL_THINKING?.trim() || "medium") as "low" | "medium" | "high";
const candidateProduct = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_FOLLOW_THROUGH_REPEATS ?? "2");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_FOLLOW_THROUGH_REPEATS must be an integer from 1 to 5.");
const onlyTask = process.env.ROTOM_EVAL_FOLLOW_THROUGH_TASK?.trim();
const baselineRef = process.env.ROTOM_EVAL_FOLLOW_THROUGH_BASELINE_REF?.trim();
// Optional real user AGENTS.md, copied into the isolated agent dir as the global context file.
const userAgentsFile = process.env.ROTOM_EVAL_FOLLOW_THROUGH_AGENTS?.trim() || undefined;
if (userAgentsFile && !isAbsolute(userAgentsFile)) throw new Error("ROTOM_EVAL_FOLLOW_THROUGH_AGENTS must be an absolute path.");

type TaskId = "archive-mismatch" | "plan-gaps" | "simple-question" | "standing-directive";
type Turn = { toolCallCount: number; endText: string };
type Output = { taskId: TaskId; response: string; toolCallCount: number; toolArguments: string; turns: Turn[]; workspace: Record<string, JsonValue> };
type TaskDefinition = {
	id: TaskId;
	prompt: string;
	/** Later user prompts, sent after the agent ends each previous turn. */
	followUps?: string[];
	files: Record<string, string>;
	inspect: (workspace: string) => Promise<Record<string, JsonValue>>;
	checks: (output: Output) => Record<string, boolean>;
};

// The turn must end with an owner for what is left: a question or a proposed action.
const NEXT_STEP = /要不要|是否需要|需要我|是否(?:要|继续|由我)|我可以|我来|下一步|如果你同意|确认后|请确认|你希望|请提供|需要你|next step|shall I|want me to|[?？]/iu;
function endsWithNextStep(response: string): boolean {
	return NEXT_STEP.test(response.slice(-500));
}

// A turn that ends by announcing work the agent itself will do next.
const SELF_OWNED_NEXT = /下一步(?:由我|我|将|会)|接下来(?:我|将|会)|我(?:接下来|将继续|会继续|继续(?:做|实现|推进))|(?:next|then) I(?:'ll| will)|I will (?:now )?(?:continue|proceed|implement)/iu;
function endsWithSelfOwnedNext(text: string): boolean {
	return SELF_OWNED_NEXT.test(text.slice(-500));
}

// Files changed since the fixture commit, committed or not. The user's AGENTS.md
// may tell the agent to commit, so a clean status alone proves nothing.
function changedFiles(workspace: string): string[] {
	const git = (...args: string[]) => spawnSync("git", args, { cwd: workspace, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
	const fixture = git("rev-list", "--max-parents=0", "HEAD")[0]!;
	return [...new Set([...git("diff", "--name-only", fixture), ...git("ls-files", "--others", "--exclude-standard")])].sort();
}

const archiveFiles: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "scry", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
	"src/history-view.js": "import { findArchive } from \"./archive-lookup.js\";\n\nexport function historyHint(session, archives) {\n\tconst archive = findArchive(session, archives);\n\tif (!archive) return { errorHint: \"未匹配到运行归档，无法核实完成状态\" };\n\treturn { status: archive.status };\n}\n",
	"src/archive-lookup.js": "import { archiveKey } from \"./keys.js\";\n\nexport function findArchive(session, archives) {\n\tconst key = archiveKey(session.cwd, session.startedAt);\n\treturn archives.find((archive) => archive.sessionId === session.id && archive.key === key) ?? null;\n}\n",
	"src/keys.js": "// Archive key: workspace directory plus the start date.\nexport function archiveKey(cwd, startedAt) {\n\treturn `${cwd}#${startedAt.slice(0, 10)}`;\n}\n",
	// No import points here; the archive writer is a separate job.
	"jobs/archive-run.js": "import { appendFile } from \"node:fs/promises\";\n\nfunction localDay(iso) {\n\treturn new Date(iso).toLocaleDateString(\"sv-SE\", { timeZone: \"Asia/Shanghai\" });\n}\n\nexport async function archiveRun(run, path) {\n\tconst record = { key: `${run.cwd}#${localDay(run.startedAt)}`, sessionId: run.sessionId, status: run.status };\n\tawait appendFile(path, `${JSON.stringify(record)}\\n`);\n}\n",
	"data/sessions.json": `${JSON.stringify([
		{ id: "s-40", cwd: "/work/scry", startedAt: "2026-03-04T02:10:00Z" },
		{ id: "s-41", cwd: "/work/scry", startedAt: "2026-03-04T09:45:00Z" },
		{ id: "s-42", cwd: "/work/scry", startedAt: "2026-03-04T17:20:00Z" },
	], null, 2)}\n`,
	"data/archives.jsonl": [
		{ key: "/work/scry#2026-03-04", sessionId: "s-40", status: "completed" },
		{ key: "/work/scry#2026-03-04", sessionId: "s-41", status: "completed" },
		{ key: "/work/scry#2026-03-05", sessionId: "s-42", status: "completed" },
	].map((record) => JSON.stringify(record)).join("\n") + "\n",
};

// Over the read tool's 50KB page, so the partition and join fields at the end
// are seen only by paging, searching, or reading the tail.
function offlineSql(): string {
	const columns = Array.from({ length: 1500 }, (_, index) => `  attr_${String(index).padStart(4, "0")} STRING COMMENT '订单扩展属性 ${String(index)}',`);
	return [
		"-- 离线订单宽表，每日 T+1 产出。",
		"CREATE TABLE IF NOT EXISTS dw_orders_wide (",
		"  order_id BIGINT COMMENT '订单 ID',",
		"  seller_key BIGINT COMMENT '商户主键（与 merchant_id 同值）',",
		...columns,
		"  gmt_modified STRING COMMENT '修改时间'",
		")",
		"PARTITIONED BY (stat_day_p STRING COMMENT '业务日分区');",
		"",
		"INSERT OVERWRITE TABLE dw_orders_wide PARTITION (stat_day_p = '${bizdate}')",
		"SELECT o.* FROM ods_orders o",
		"JOIN dim_merchant m ON o.seller_key = m.merchant_id",
		"WHERE o.ds = '${bizdate}';",
		"",
	].join("\n");
}

const planFiles: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "orders-sync", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
	"db/schema.sql": "CREATE TABLE merchant_whitelist (\n  id BIGINT PRIMARY KEY AUTO_INCREMENT,\n  merchant_id BIGINT NOT NULL,\n  account_id BIGINT NOT NULL,\n  status TINYINT NOT NULL DEFAULT 1,\n  UNIQUE KEY uk_merchant_account (merchant_id, account_id)\n);\n",
	"src/sync/incremental.js": "import { writeIGraph } from \"./igraph-writer.js\";\n\n// Called for every order change from the binlog consumer.\nexport async function onOrderChange(change) {\n\tif (change.type === \"delete\") return writeIGraph({ op: \"delete\", orderId: change.orderId });\n\treturn writeIGraph({ op: \"upsert\", orderId: change.orderId, merchantId: change.merchantId, payload: change.payload });\n}\n",
	"src/sync/igraph-writer.js": "export async function writeIGraph(record) {\n\t// Thin client; the real transport is injected in production.\n\treturn { written: true, record };\n}\n",
	"sql/offline_orders.sql": offlineSql(),
	"vendor/nick-sdk/README.md": "# nick-sdk\n\nBinary-only SDK for account nicknames. Source and API docs are not included in this repository.\nAccess and documentation are owned by the nick-platform team.\n",
};

const milestoneTest = (name: string, body: string) => `import assert from "node:assert/strict";\nimport test from "node:test";\n${body}\n`;
const LOG = "2026-10-23T08:00:00Z s-1 request 1200\\n2026-10-23T08:00:05Z s-1 error 300\\nbroken line\\n2026-10-23T08:01:00Z s-2 request 800\\n2026-10-23T08:02:00Z s-1 request 2000\\n";
const directiveFiles: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "trace-report", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
	"README.md": "# trace-report\n\nSummarize request traces per session.\n",
	"docs/PLAN.md": [
		"# trace-report 计划",
		"",
		"日志每行格式：`<ISO 时间> <session> <event> <耗时毫秒>`，event 为 request 或 error。每个里程碑都有验收测试 `test/mN.test.js`，测试通过才算完成。",
		"",
		"- M1 `src/parse.js`：`parseLine(line)` 返回 `{ ts, session, event, ms }`（ms 为数字）；格式不对返回 null。",
		"- M2 `src/aggregate.js`：`aggregate(records)` 按 session 汇总为 `{ [session]: { requests, errors, totalMs, maxMs } }`，request 与 error 都计入 totalMs/maxMs。",
		"- M3 `src/report.js`：`renderTable(summary)` 输出 Markdown 表，表头 `| session | requests | errors | totalMs | maxMs |`，按 totalMs 降序。",
		"- M4 `bin/report.js`：`node bin/report.js <log>` 打印表格；加 `--json` 打印汇总 JSON；文件不存在时向 stderr 输出错误并以退出码 2 结束。",
		"- M5 README：补充 Usage 小节，写明两种命令用法和退出码 2 的含义；`test/m5.test.js` 检查。",
		"",
	].join("\n"),
	"test/m1.test.js": milestoneTest("m1", `import { parseLine } from "../src/parse.js";\ntest("M1 parseLine", () => {\n\tassert.deepEqual(parseLine("2026-10-23T08:00:00Z s-1 request 1200"), { ts: "2026-10-23T08:00:00Z", session: "s-1", event: "request", ms: 1200 });\n\tassert.equal(parseLine("broken line"), null);\n\tassert.equal(parseLine("2026-10-23T08:00:00Z s-1 request fast"), null);\n});`),
	"test/m2.test.js": milestoneTest("m2", `import { parseLine } from "../src/parse.js";\nimport { aggregate } from "../src/aggregate.js";\ntest("M2 aggregate", () => {\n\tconst records = "${LOG}".split("\\n").map(parseLine).filter(Boolean);\n\tassert.deepEqual(aggregate(records), { "s-1": { requests: 2, errors: 1, totalMs: 3500, maxMs: 2000 }, "s-2": { requests: 1, errors: 0, totalMs: 800, maxMs: 800 } });\n});`),
	"test/m3.test.js": milestoneTest("m3", `import { renderTable } from "../src/report.js";\ntest("M3 renderTable", () => {\n\tconst lines = renderTable({ a: { requests: 1, errors: 0, totalMs: 10, maxMs: 10 }, b: { requests: 2, errors: 1, totalMs: 50, maxMs: 30 } }).trim().split("\\n");\n\tassert.equal(lines[0], "| session | requests | errors | totalMs | maxMs |");\n\tassert.match(lines[2], /^\\| b \\| 2 \\| 1 \\| 50 \\| 30 \\|$/);\n\tassert.match(lines[3], /^\\| a \\|/);\n});`),
	"test/m4.test.js": milestoneTest("m4", `import { spawnSync } from "node:child_process";\nimport { mkdtempSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\ntest("M4 CLI", () => {\n\tconst log = join(mkdtempSync(join(tmpdir(), "m4-")), "trace.log");\n\twriteFileSync(log, "${LOG}");\n\tconst table = spawnSync(process.execPath, ["bin/report.js", log], { encoding: "utf8" });\n\tassert.equal(table.status, 0);\n\tassert.match(table.stdout, /\\| s-1 \\| 2 \\| 1 \\| 3500 \\| 2000 \\|/);\n\tconst json = spawnSync(process.execPath, ["bin/report.js", log, "--json"], { encoding: "utf8" });\n\tassert.equal(JSON.parse(json.stdout)["s-2"].totalMs, 800);\n\tconst missing = spawnSync(process.execPath, ["bin/report.js", log + ".missing"], { encoding: "utf8" });\n\tassert.equal(missing.status, 2);\n\tassert.ok(missing.stderr.length > 0);\n});`),
	"test/m5.test.js": milestoneTest("m5", `import { readFileSync } from "node:fs";\ntest("M5 README usage", () => {\n\tconst readme = readFileSync("README.md", "utf8");\n\tassert.match(readme, /## Usage/);\n\tassert.match(readme, /--json/);\n\tassert.match(readme, /\\b2\\b/);\n});`),
};

function acceptance(workspace: string): Record<string, boolean> {
	return Object.fromEntries(["m1", "m2", "m3", "m4", "m5"].map((name) => [name, spawnSync(process.execPath, ["--test", `test/${name}.test.js`], { cwd: workspace, encoding: "utf8", timeout: 60_000 }).status === 0]));
}

const tasks: TaskDefinition[] = [
	{
		id: "archive-mismatch",
		prompt: "会话 s-42 在历史页显示红字「未匹配到运行归档，无法核实完成状态」，同一天的其他会话都正常。帮我查清楚为什么这个会话没匹配到归档。先别改代码。",
		files: archiveFiles,
		async inspect(workspace) { return { changedFiles: changedFiles(workspace) }; },
		checks: ({ response, toolArguments, workspace }) => ({
			namesTimezoneCause: /时区|UTC|北京时间|Asia\/Shanghai|东八|time ?zone/iu.test(response),
			namesBothDates: /03-04|3 ?月 ?4/u.test(response) && /03-05|3 ?月 ?5/u.test(response),
			foundWriter: /archive-run/u.test(toolArguments) || /archive-run/u.test(response),
			readData: /archives\.jsonl/u.test(toolArguments),
			noEdits: (workspace.changedFiles as string[]).length === 0,
			endsWithNextStep: endsWithNextStep(response),
		}),
	},
	{
		id: "plan-gaps",
		prompt: "给订单增量同步加商户白名单过滤：非白名单商户不写 iGraph。把方案写到 docs/plan.md，需要说明：白名单表结构、增量写入入口、离线 SQL 的分区字段和关联字段、账号昵称怎么查。不要改业务代码。",
		files: planFiles,
		async inspect(workspace) {
			const plan = await readFile(join(workspace, "docs/plan.md"), "utf8").catch(() => "");
			return { plan, changedFiles: changedFiles(workspace) };
		},
		checks: ({ response, workspace }) => {
			const plan = String(workspace.plan);
			const both = `${plan}\n${response}`;
			const changed = workspace.changedFiles as string[];
			return {
				planWritten: plan.length > 0,
				partitionField: /stat_day_p/u.test(plan),
				joinField: /seller_key/u.test(plan),
				entryPoint: /onOrderChange|incremental\.js/u.test(plan),
				nicknameBlockerNamed: /nick-platform|nick-sdk/iu.test(both),
				onlyPlanChanged: changed.length === 1 && changed[0] === "docs/plan.md",
				endsWithNextStep: endsWithNextStep(response),
			};
		},
	},
	{
		id: "simple-question",
		prompt: "这个项目跑测试用什么命令？直接告诉我，不用运行。",
		files: archiveFiles,
		async inspect() { return {}; },
		checks: ({ response, toolCallCount }) => ({
			answers: /npm (?:run )?test|node --test/u.test(response),
			staysShort: response.length <= 300,
			fewTools: toolCallCount <= 2,
		}),
	},
	{
		id: "standing-directive",
		prompt: "按 docs/PLAN.md 完成 M1–M5。期间不要停下来，全部做完后一起交付结果。",
		followUps: ["目前什么进度了？"],
		files: directiveFiles,
		async inspect(workspace) { return { acceptance: acceptance(workspace) }; },
		checks: ({ turns, workspace }) => {
			const passed = workspace.acceptance as Record<string, boolean>;
			return {
				allMilestonesPass: Object.values(passed).every(Boolean),
				firstTurnNoSelfOwnedNext: !endsWithSelfOwnedNext(turns[0]?.endText ?? ""),
				lastTurnNoSelfOwnedNext: !endsWithSelfOwnedNext(turns.at(-1)?.endText ?? ""),
			};
		},
	},
];

function taskForInput(input: PiCodingAgentInput): TaskDefinition {
	const id = typeof input === "object" && !Array.isArray(input) ? input.id : undefined;
	const task = tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Unknown follow-through task: ${String(id)}`);
	return task;
}

async function setupWorkspace({ input, workspace, configDir }: PiEvalWorkspaceContext): Promise<void> {
	if (userAgentsFile) await copyFile(userAgentsFile, join(configDir, "AGENTS.md"));
	for (const [relativePath, content] of Object.entries(taskForInput(input).files)) {
		const path = join(workspace, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	const git = (...args: string[]) => {
		const result = spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
		if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	};
	git("init", "--quiet");
	git("add", "-A");
	git("commit", "--quiet", "-m", "fixture");
}

// One entry per user prompt: tool calls made in that turn and the final assistant text.
function turnsOf(messages: readonly unknown[]): Turn[] {
	const turns: Turn[] = [];
	for (const message of messages as Array<{ role?: string; content?: unknown }>) {
		if (message.role === "user") turns.push({ toolCallCount: 0, endText: "" });
		const turn = turns.at(-1);
		if (!turn || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const blocks = message.content as Array<{ type?: string; text?: string }>;
		turn.toolCallCount += blocks.filter((block) => block?.type === "toolCall").length;
		const text = blocks.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
		if (text.trim()) turn.endText = text;
	}
	return turns;
}

function toolCalls(messages: readonly unknown[]): Array<{ arguments?: unknown }> {
	return (messages as Array<{ role?: string; content?: unknown }>)
		.filter((message) => message.role === "assistant" && Array.isArray(message.content))
		.flatMap((message) => (message.content as Array<{ type?: string; arguments?: unknown }>).filter((block) => block?.type === "toolCall"));
}

// Project only the policy file at the baseline ref; readHygienePolicy needs a product-shaped directory.
function policyAtRef(ref: string) {
	const shown = spawnSync("git", ["show", `${ref}:./extensions/coding-policy/index.ts`], { cwd: candidateProduct, encoding: "utf8" });
	if (shown.status !== 0) throw new Error(`git show ${ref} coding-policy failed: ${shown.stderr}`);
	const directory = mkdtempSync(join(tmpdir(), "rotom-follow-through-baseline-"));
	mkdirSync(join(directory, "extensions/coding-policy"), { recursive: true });
	writeFileSync(join(directory, "extensions/coding-policy/index.ts"), shown.stdout);
	return readHygienePolicy(directory);
}

function harness(name: string, armPolicy: ReturnType<typeof readHygienePolicy>) {
	return createPiCodingAgentHarness<Output>({
		name,
		model: { provider: provider!, id: model! },
		thinkingLevel,
		tools: ["read", "bash", "edit", "write"],
		productAgentDir: candidateProduct,
		excludedResourceKeys: [CODING_POLICY_RESOURCE_KEY],
		inlineExtensions: [hygienePolicyInlineExtension(armPolicy)],
		setupWorkspace,
		noContextFiles: !userAgentsFile,
		async output({ input, workspace, configDir, response, session }) {
			const task = taskForInput(input);
			// Fail closed: a run that claims user context must have sent it.
			if (userAgentsFile && !session.systemPrompt.includes((await readFile(join(configDir, "AGENTS.md"), "utf8")).trim())) throw new Error("User AGENTS.md was not loaded into the system prompt.");
			const calls = toolCalls(session.messages);
			return {
				taskId: task.id,
				response,
				toolCallCount: calls.length,
				toolArguments: calls.map((call) => JSON.stringify(call.arguments ?? {})).join("\n"),
				turns: turnsOf(session.messages),
				workspace: await task.inspect(workspace),
			};
		},
	});
}

function judgeFor(task: TaskDefinition) {
	return createJudge<PiCodingAgentInput, Output>(`FollowThrough-${task.id}`, ({ output }) => {
		const checks = { taskIdentity: output.taskId === task.id, ...task.checks(output) };
		const passed = Object.values(checks).filter(Boolean).length;
		const { plan, ...workspace } = output.workspace;
		return {
			score: passed / Object.keys(checks).length,
			metadata: {
				rationale: JSON.stringify(checks),
				output: { checks, responseLength: output.response.length, toolCallCount: output.toolCallCount, turns: output.turns.map(({ toolCallCount, endText }) => ({ toolCallCount, endTail: endText.slice(-300) })), workspace, plan: plan ?? null, response: output.response } as JsonValue,
			},
		};
	});
}

if (!enabled || !provider || !model || !baselineRef) {
	describe.skip("follow-through A/B requires ROTOM_EVAL_FOLLOW_THROUGH=1, ROTOM_EVAL_FOLLOW_THROUGH_BASELINE_REF, provider, and model", () => {});
} else {
	const candidatePolicy = readHygienePolicy(candidateProduct);
	if (!candidatePolicy.followThrough) throw new Error(`Candidate product ${candidateProduct} has no FOLLOW_THROUGH_POLICY`);
	const baselinePolicy = policyAtRef(baselineRef);
	for (const task of tasks.filter((candidate) => !onlyTask || candidate.id === onlyTask)) {
		const scenario = { id: task.id, steps: [task.prompt, ...(task.followUps ?? [])].map((content) => ({ type: "prompt" as const, content })) } satisfies PiCodingAgentScenario;
		const planned = evalHarnessTable(`Follow-through: ${task.id}`, {
			baseline: harness(`baseline-${baselineRef}`, baselinePolicy),
			candidate: harness("candidate", candidatePolicy),
			repetitions,
		});
		// Alternate arm order per repetition so provider drift does not favour one arm.
		const rows = Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
		for (const row of rows) {
			describeEval(`${task.id}: ${row.name} repetition ${String(row.repetition)}`, {
				harness: row.harness,
				judges: [judgeFor(task)],
				judgeThreshold: 0,
			}, (it) => {
				it(task.id, async ({ run }) => { await run(scenario); });
			});
		}
	}
}
