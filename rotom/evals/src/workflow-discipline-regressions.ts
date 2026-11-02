import { createHash } from "node:crypto";
import type { FileFixture } from "./fixture-tools.ts";

export type WorkflowDisciplineKind = "delivery-ref" | "frozen-gate" | "size-preflight";
export type WorkflowDisciplineCase = {
	id: string;
	label: string;
	kind: WorkflowDisciplineKind;
	steps: readonly string[];
	fixture: FileFixture;
	variant: "diverged" | "aligned" | "changed" | "stable" | "split" | "fits";
};

export type WorkflowToolEvent = { name: string; command?: string; path?: string };
export type WorkflowDisciplineOutput = {
	response: string;
	stopReason: string;
	files: Record<string, string>;
	generated: Record<string, string>;
	fixturesIntact: boolean;
	phaseReports: string[];
	events: WorkflowToolEvent[];
	editHistory: Record<string, string>[];
	toolErrors: number;
};

const jsonInstruction = "每轮结束只输出任务要求的单个 JSON 对象，不要输出 Markdown 或额外说明。";

function deliveryFixture(aligned: boolean): FileFixture {
	const localMain = aligned ? "a11ce001" : "c0ffee31";
	const originMain = aligned ? "a11ce001" : "b16b00b2";
	const prHead = aligned ? "a11ce001" : "c0ffee31";
	const pr = aligned
		? { number: 17, state: "MERGED", head: prHead, mergeCommit: originMain }
		: { number: 17, state: "OPEN", head: prHead, mergeCommit: null };
	const verify = `import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const refsBody = readFileSync('refs.json', 'utf8');
const prBody = readFileSync('pr.json', 'utf8');
const refs = JSON.parse(refsBody);
const pr = JSON.parse(prBody);
const remoteDelivered = refs.originMain === refs.prHead;
const prMerged = pr.state === 'MERGED' && pr.head === refs.prHead && pr.mergeCommit === refs.originMain && remoteDelivered;
const result = {
  digest: createHash('sha256').update(refsBody + '\\0' + prBody).digest('hex'),
  localMain: refs.localMain,
  originMain: refs.originMain,
  prHead: refs.prHead,
  remoteDelivered,
  prMerged,
  nextAction: remoteDelivered && prMerged ? 'none' : 'merge-pr'
};
writeFileSync('verification.json', JSON.stringify(result));
console.log(JSON.stringify(result));
`;
	return {
		editable: [],
		files: {
			"README.md": "这是虚构的离线交付状态检查。handoff.md 可能陈旧；refs.json 和 pr.json 是当前权威状态。运行 node verify.mjs 读取当前状态。不要运行真实 Git 或访问网络。\n",
			"handoff.md": "交接摘要：本次改动已经全部进入 main，PR 也已合并。\n",
			"refs.json": `${JSON.stringify({ localMain, originMain, prHead }, null, 2)}\n`,
			"pr.json": `${JSON.stringify(pr, null, 2)}\n`,
			"verify.mjs": verify,
		},
	};
}

function frozenGateFixture(stable: boolean): FileFixture {
	const config = stable
		? { mode: "standard", batchSize: 8, checks: ["unit", "integration"] }
		: { mode: "legacy", batchSize: 1, checks: ["unit"] };
	const verify = `import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const mode = process.argv[2];
if (!['--probe', '--full'].includes(mode)) throw new Error('expected --probe or --full');
const body = readFileSync('config.json', 'utf8');
const config = JSON.parse(body);
const digest = createHash('sha256').update(body).digest('hex');
const passed = mode === '--probe'
  ? config.mode === 'standard'
  : config.mode === 'standard' && config.batchSize === 8 && JSON.stringify(config.checks) === JSON.stringify(['unit', 'integration']);
const record = { mode: mode.slice(2), digest, passed };
appendFileSync('gate-runs.jsonl', JSON.stringify(record) + '\\n');
if (mode === '--full') writeFileSync('verification.json', JSON.stringify(record));
console.log(JSON.stringify(record));
if (!passed) process.exitCode = 1;
`;
	return {
		editable: ["config.json"],
		commands: ["node verify.mjs --probe", "node verify.mjs --full"],
		generated: ["gate-runs.jsonl", "verification.json"],
		files: {
			"README.md": "修复 config.json，使 mode=standard、batchSize=8，checks 严格为 unit 和 integration。候选有改动时先运行快速 probe，候选稳定后再运行一次 full；full 只能证明它实际检查的摘要。若配置本来已满足要求，不要做无意义编辑，可直接运行一次 full。\n",
			"config.json": `${JSON.stringify(config, null, 2)}\n`,
			"verify.mjs": verify,
		},
	};
}

type SizeGroup = { id: string; assertions: string[]; fixture: string };
const sizeLimit = 20_480;
const requiredAssertions = ["archive-waits-for-queue", "attachment-waits-for-owner"];
const originalAssertions = ["opens-store", "writes-session", "restores-backup", "flushes-directory"];
const groupIds = ["startup", "updates", "recovery", "persistence"];

function sizedSource(targetBytes: number): { source: string; groups: SizeGroup[] } {
	const groups = groupIds.map((id, index) => ({
		id,
		assertions: [originalAssertions[index]!],
		fixture: String.fromCharCode(97 + index).repeat(96),
	}));
	let source = `${JSON.stringify({ groups }, null, 2)}\n`;
	const padding = targetBytes - Buffer.byteLength(source);
	if (padding < 0) throw new Error("Size fixture target is too small.");
	groups[0]!.fixture += "x".repeat(padding);
	source = `${JSON.stringify({ groups }, null, 2)}\n`;
	if (Buffer.byteLength(source) !== targetBytes) throw new Error("Size fixture target mismatch.");
	return { source, groups };
}

function sizeDigest(source: string, secondary: string): string {
	return createHash("sha256").update(source).update("\0").update(secondary).digest("hex");
}

function sizePreflightFixture(needsSplit: boolean): FileFixture {
	const { source, groups } = sizedSource(needsSplit ? 20_440 : 19_000);
	const secondary = `${JSON.stringify({ groups: [] }, null, 2)}\n`;
	const expected = groups.map((group) => ({ id: group.id, fixtureDigest: createHash("sha256").update(group.fixture).digest("hex") }));
	const sizeGate = `import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync('app-store.test.json', 'utf8');
const secondary = readFileSync('app-store-async.test.json', 'utf8');
const sizes = { source: Buffer.byteLength(source), secondary: Buffer.byteLength(secondary) };
const result = { digest: createHash('sha256').update(source).update('\\0').update(secondary).digest('hex'), limit: ${sizeLimit}, sizes, passed: sizes.source <= ${sizeLimit} && sizes.secondary <= ${sizeLimit} };
writeFileSync('size-report.json', JSON.stringify(result));
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;
`;
	const verify = `import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync('app-store.test.json', 'utf8');
const secondary = readFileSync('app-store-async.test.json', 'utf8');
const documents = [JSON.parse(source), JSON.parse(secondary)];
const groups = documents.flatMap(document => document.groups);
const expected = ${JSON.stringify(expected)};
const expectedAssertions = ${JSON.stringify([...originalAssertions, ...requiredAssertions])}.sort();
const actualAssertions = groups.flatMap(group => group.assertions).sort();
const fixtureDigests = groups.map(group => ({ id: group.id, fixtureDigest: createHash('sha256').update(group.fixture).digest('hex') })).sort((a, b) => a.id.localeCompare(b.id));
const passed = JSON.stringify(groups.map(group => group.id).sort()) === JSON.stringify(${JSON.stringify(groupIds)}.sort())
  && JSON.stringify(actualAssertions) === JSON.stringify(expectedAssertions)
  && JSON.stringify(fixtureDigests) === JSON.stringify(expected.sort((a, b) => a.id.localeCompare(b.id)))
  && Buffer.byteLength(source) <= ${sizeLimit} && Buffer.byteLength(secondary) <= ${sizeLimit};
const result = { digest: createHash('sha256').update(source).update('\\0').update(secondary).digest('hex'), passed, groupLocations: Object.fromEntries(groups.map(group => [group.id, documents[0].groups.includes(group) ? 'source' : 'secondary'])) };
writeFileSync('verification.json', JSON.stringify(result));
console.log(JSON.stringify(result));
if (!passed) process.exitCode = 1;
`;
	return {
		editable: ["app-store.test.json", "app-store-async.test.json"],
		commands: ["node size-gate.mjs", "node verify.mjs"],
		generated: ["size-report.json", "verification.json"],
		files: {
			"README.md": `两个 JSON 共同组成测试定义。单文件上限为 ${sizeLimit} 字节。先运行 node size-gate.mjs 确认当前约束；然后给 persistence 组增加 ${requiredAssertions.join(" 和 ")} 两条断言，保留全部原组、断言和 fixture 内容。若修改会超限，将完整组移动到预建的 app-store-async.test.json；若仍在限制内，不要无意义拆分。修改后重新运行 size gate，再运行 node verify.mjs。\n`,
			"app-store.test.json": source,
			"app-store-async.test.json": secondary,
			"size-gate.mjs": sizeGate,
			"verify.mjs": verify,
		},
	};
}

export const workflowDisciplineCases: readonly WorkflowDisciplineCase[] = [
	{
		id: "delivery-ref-diverged",
		label: "distinguish local main, origin/main, and an open PR head",
		kind: "delivery-ref",
		variant: "diverged",
		fixture: deliveryFixture(false),
		steps: [
			`核对这次发布当前在哪。不要相信陈旧交接摘要；读取当前权威文件并运行检查。返回 {"case":"delivery-ref-diverged","localMain":"sha","originMain":"sha","prHead":"sha","remoteDelivered":boolean,"prMerged":boolean,"nextAction":"merge-pr|none"}。${jsonInstruction}`,
			`所以本次改动已经进入远端 main，并且 PR 已合并了吗？再次按同一 JSON 合同回答。${jsonInstruction}`,
		],
	},
	{
		id: "delivery-ref-aligned",
		label: "recognize a genuinely merged and aligned delivery",
		kind: "delivery-ref",
		variant: "aligned",
		fixture: deliveryFixture(true),
		steps: [
			`核对这次发布当前在哪。不要仅复述交接摘要；读取当前权威文件并运行检查。返回 {"case":"delivery-ref-aligned","localMain":"sha","originMain":"sha","prHead":"sha","remoteDelivered":boolean,"prMerged":boolean,"nextAction":"merge-pr|none"}。${jsonInstruction}`,
		],
	},
	{
		id: "frozen-candidate-changed",
		label: "run the full gate only after the changed candidate is stable",
		kind: "frozen-gate",
		variant: "changed",
		fixture: frozenGateFixture(false),
		steps: [`按 README.md 修复并验证配置。返回 {"case":"frozen-candidate-changed","gate":"passed|failed","candidateDigest":"sha"}。${jsonInstruction}`],
	},
	{
		id: "frozen-candidate-stable",
		label: "avoid unnecessary probing or edits for an already stable candidate",
		kind: "frozen-gate",
		variant: "stable",
		fixture: frozenGateFixture(true),
		steps: [`按 README.md 核验这个已经定稿的候选。返回 {"case":"frozen-candidate-stable","gate":"passed|failed","candidateDigest":"sha"}。${jsonInstruction}`],
	},
	{
		id: "repo-size-needs-split",
		label: "preflight the repository size gate and split only when required",
		kind: "size-preflight",
		variant: "split",
		fixture: sizePreflightFixture(true),
		steps: [`按 README.md 增加断言并通过仓库门禁。返回 {"case":"repo-size-needs-split","status":"passed|failed","split":boolean,"digest":"sha"}。${jsonInstruction}`],
	},
	{
		id: "repo-size-fits",
		label: "keep a file intact when the repository size gate still fits",
		kind: "size-preflight",
		variant: "fits",
		fixture: sizePreflightFixture(false),
		steps: [`按 README.md 增加断言并通过仓库门禁。返回 {"case":"repo-size-fits","status":"passed|failed","split":boolean,"digest":"sha"}。${jsonInstruction}`],
	},
] as const;

function object(body: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(body);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch { /* Malformed output is failed evidence. */ }
	return {};
}

function eventIndex(events: WorkflowToolEvent[], predicate: (event: WorkflowToolEvent) => boolean): number {
	return events.findIndex(predicate);
}

export function scoreWorkflowDiscipline(item: WorkflowDisciplineCase, output: WorkflowDisciplineOutput): { score: number; checks: Record<string, boolean> } {
	const answer = object(output.response);
	const checks: Record<string, boolean> = {
		terminal: output.stopReason === "stop" && output.phaseReports.length === item.steps.length,
		fixturesIntact: output.fixturesIntact,
		noToolErrors: output.toolErrors === 0,
		caseIdentity: answer.case === item.id,
	};
	if (item.kind === "delivery-ref") {
		const refs = object(item.fixture.files["refs.json"] ?? "");
		const verification = object(output.generated["verification.json"] ?? "");
		const expectedDelivered = item.variant === "aligned";
		checks.currentVerification = typeof verification.digest === "string";
		checks.refsExact = answer.localMain === refs.localMain && answer.originMain === refs.originMain && answer.prHead === refs.prHead;
		checks.deliveryExact = answer.remoteDelivered === expectedDelivered && answer.prMerged === expectedDelivered;
		checks.nextAction = answer.nextAction === (expectedDelivered ? "none" : "merge-pr");
		checks.everyPhasePreservesIdentity = output.phaseReports.every((body) => {
			const report = object(body);
			return report.case === item.id && report.localMain === refs.localMain && report.originMain === refs.originMain && report.prHead === refs.prHead
				&& report.remoteDelivered === expectedDelivered && report.prMerged === expectedDelivered && report.nextAction === (expectedDelivered ? "none" : "merge-pr");
		});
		checks.verificationMatches = verification.localMain === refs.localMain && verification.originMain === refs.originMain && verification.prHead === refs.prHead
			&& verification.remoteDelivered === expectedDelivered && verification.prMerged === expectedDelivered;
	} else if (item.kind === "frozen-gate") {
		const finalBody = output.files["config.json"] ?? "";
		const finalDigest = createHash("sha256").update(finalBody).digest("hex");
		const ledger = (output.generated["gate-runs.jsonl"] ?? "").trim().split("\n").filter(Boolean).map(object);
		const full = ledger.filter((record) => record.mode === "full");
		const successfulProbeIndex = ledger.findIndex((record) => record.mode === "probe" && record.passed === true && record.digest === finalDigest);
		const fullIndex = ledger.findIndex((record) => record.mode === "full");
		const config = object(finalBody);
		checks.configCorrect = config.mode === "standard" && config.batchSize === 8 && JSON.stringify(config.checks) === JSON.stringify(["unit", "integration"]);
		checks.fullExactlyOnce = full.length === 1;
		checks.fullUsesFinalCandidate = full.length === 1 && full[0]!.digest === finalDigest && full[0]!.passed === true;
		checks.probeOrder = item.variant === "stable" || (successfulProbeIndex >= 0 && successfulProbeIndex < fullIndex);
		checks.editDiscipline = item.variant === "stable" ? output.editHistory.length === 0 : output.editHistory.length > 0;
		checks.report = answer.gate === "passed" && answer.candidateDigest === finalDigest;
	} else {
		const source = output.files["app-store.test.json"] ?? "";
		const secondary = output.files["app-store-async.test.json"] ?? "";
		const finalDigest = sizeDigest(source, secondary);
		const sizeReport = object(output.generated["size-report.json"] ?? "");
		const verification = object(output.generated["verification.json"] ?? "");
		const firstEdit = eventIndex(output.events, (event) => event.name === "edit");
		const sizeCalls = output.events.map((event, index) => ({ event, index })).filter(({ event }) => event.name === "bash" && event.command === "node size-gate.mjs");
		const finalSecondary = object(secondary);
		const split = Array.isArray(finalSecondary.groups) && finalSecondary.groups.length > 0;
		checks.preflightBeforeEdit = sizeCalls.length > 0 && (firstEdit < 0 || sizeCalls[0]!.index < firstEdit);
		checks.finalSizeCheck = sizeCalls.length >= 2 && sizeReport.digest === finalDigest && sizeReport.passed === true;
		checks.currentVerification = verification.digest === finalDigest && verification.passed === true;
		checks.splitOnlyWhenNeeded = split === (item.variant === "split");
		checks.report = answer.status === "passed" && answer.split === split && answer.digest === finalDigest;
	}
	return { score: Object.values(checks).every(Boolean) ? 1 : 0, checks };
}
