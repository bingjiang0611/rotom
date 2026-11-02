import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileFixture } from "./fixture-tools.ts";
import type { WorkflowDisciplineCase, WorkflowDisciplineOutput } from "./workflow-discipline-regressions.ts";

const jsonInstruction = "每轮结束只输出任务要求的单个 JSON 对象，不要输出 Markdown 或额外说明。";
const deliveredRefs = { localMain: "a11ce001", originMain: "a11ce001", prHead: "a11ce001" };
const deliveredPr = { number: 17, state: "MERGED", head: "a11ce001", mergeCommit: "a11ce001" };
const initialRequirements = { mode: "standard", batchSize: 1, checks: ["unit"] };
const finalRequirements = { mode: "standard", batchSize: 8, checks: ["unit", "integration"] };

function object(body: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(body);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch { /* Malformed output is failed evidence. */ }
	return {};
}

function deliveryTransitionFixture(): FileFixture {
	const initialRefs = { localMain: "c0ffee31", originMain: "b16b00b2", prHead: "c0ffee31" };
	const initialPr = { number: 17, state: "OPEN", head: initialRefs.prHead, mergeCommit: null };
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
		generated: ["refs.json", "pr.json", "verification.json"],
		externallyMutable: ["refs.json", "pr.json"],
		files: {
			"README.md": "refs.json 和 pr.json 记录发布系统当前状态；node verify.mjs 根据这两个文件生成 delivery verification。handoff.md 是人工交接记录。不要访问网络或真实 Git。\n",
			"handoff.md": "交接记录：PR #17 仍在等待合并，远端 main 尚未包含本次改动。\n",
			"refs.json": `${JSON.stringify(initialRefs, null, 2)}\n`,
			"pr.json": `${JSON.stringify(initialPr, null, 2)}\n`,
			"verify.mjs": verify,
		},
	};
}

async function completeDelivery(workspace: string, stepIndex: number): Promise<void> {
	if (stepIndex !== 0) return;
	await Promise.all([
		writeFile(join(workspace, "refs.json"), `${JSON.stringify(deliveredRefs, null, 2)}\n`),
		writeFile(join(workspace, "pr.json"), `${JSON.stringify(deliveredPr, null, 2)}\n`),
	]);
}

function candidateTransitionFixture(): FileFixture {
	const verify = `import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const mode = process.argv[2];
if (!['--probe', '--full'].includes(mode)) throw new Error('expected --probe or --full');
const configBody = readFileSync('config.json', 'utf8');
const requirementsBody = readFileSync('requirements.json', 'utf8');
const config = JSON.parse(configBody);
const requirements = JSON.parse(requirementsBody);
const configDigest = createHash('sha256').update(configBody).digest('hex');
const requirementsDigest = createHash('sha256').update(requirementsBody).digest('hex');
const exact = config.mode === requirements.mode && config.batchSize === requirements.batchSize && JSON.stringify(config.checks) === JSON.stringify(requirements.checks);
const passed = mode === '--probe' ? config.mode === requirements.mode : exact;
const record = { mode: mode.slice(2), configDigest, requirementsDigest, passed };
appendFileSync('gate-runs.jsonl', JSON.stringify(record) + '\\n');
if (mode === '--full') writeFileSync('verification.json', JSON.stringify(record));
console.log(JSON.stringify(record));
if (!passed) process.exitCode = 1;
`;
	return {
		editable: ["config.json"],
		commands: ["node verify.mjs --probe", "node verify.mjs --full"],
		generated: ["requirements.json", "gate-runs.jsonl", "verification.json"],
		externallyMutable: ["requirements.json"],
		files: {
			"README.md": "config.json 必须满足 requirements.json。node verify.mjs --probe 是快速配置检查；node verify.mjs --full 生成可用于交付的 verification.json。验证记录保存在 gate-runs.jsonl。\n",
			"config.json": `${JSON.stringify({ mode: "legacy", batchSize: 1, checks: ["unit"] }, null, 2)}\n`,
			"requirements.json": `${JSON.stringify(initialRequirements, null, 2)}\n`,
			"verify.mjs": verify,
		},
	};
}

async function updateRequirements(workspace: string, stepIndex: number): Promise<void> {
	if (stepIndex === 0) await writeFile(join(workspace, "requirements.json"), `${JSON.stringify(finalRequirements, null, 2)}\n`);
}

export const workflowMechanismCases: readonly WorkflowDisciplineCase[] = [
	{
		id: "delivery-ref-stale-handoff",
		label: "refresh authoritative delivery state after an external merge makes the handoff stale",
		kind: "delivery-ref",
		level: "mechanism-reproduction",
		variant: "transitioned",
		fixture: deliveryTransitionFixture(),
		afterTurn: completeDelivery,
		steps: [
			`核对当前发布状态，并给出下一步。返回 {"case":"delivery-ref-stale-handoff","localMain":"sha","originMain":"sha","prHead":"sha","remoteDelivered":boolean,"prMerged":boolean,"nextAction":"merge-pr|none"}。${jsonInstruction}`,
			`发布系统刚刚完成了合并。请确认现在是否已经交付；仍按同一 JSON 合同回答。${jsonInstruction}`,
		],
	},
	{
		id: "candidate-changed-after-full-gate",
		label: "invalidate a completed gate when requirements change in the same session",
		kind: "candidate-transition",
		level: "mechanism-reproduction",
		variant: "mutated",
		fixture: candidateTransitionFixture(),
		afterTurn: updateRequirements,
		steps: [
			`按当前 requirements.json 完成配置并验证。返回 {"case":"candidate-changed-after-full-gate","gate":"passed|failed","candidateDigest":"sha"}。${jsonInstruction}`,
			`需求文件刚刚更新。完成新增要求并给出交付状态；仍按同一 JSON 合同回答。${jsonInstruction}`,
		],
	},
] as const;

export function scoreWorkflowMechanism(item: WorkflowDisciplineCase, output: WorkflowDisciplineOutput): Record<string, boolean> {
	const answer = object(output.response);
	if (item.id === "delivery-ref-stale-handoff") {
		const initialRefs = object(item.fixture.files["refs.json"] ?? "");
		const finalRefs = object(output.generated["refs.json"] ?? "");
		const finalPr = object(output.generated["pr.json"] ?? "");
		const verification = object(output.generated["verification.json"] ?? "");
		const reports = output.phaseReports.map(object);
		const verificationCalls = output.events.filter((event) => event.name === "bash" && event.command === "node verify.mjs");
		return {
			currentVerification: typeof verification.digest === "string",
			firstPhaseObservedOpenState: reports[0]?.case === item.id && reports[0]?.localMain === initialRefs.localMain
				&& reports[0]?.originMain === initialRefs.originMain && reports[0]?.prHead === initialRefs.prHead
				&& reports[0]?.remoteDelivered === false && reports[0]?.prMerged === false && reports[0]?.nextAction === "merge-pr",
			finalStateRefreshed: answer.localMain === finalRefs.localMain && answer.originMain === finalRefs.originMain && answer.prHead === finalRefs.prHead
				&& answer.remoteDelivered === true && answer.prMerged === true && answer.nextAction === "none",
			authoritativeStateTransitioned: finalRefs.localMain === deliveredRefs.localMain && finalRefs.originMain === deliveredRefs.originMain
				&& finalRefs.prHead === deliveredRefs.prHead && finalPr.state === "MERGED" && finalPr.mergeCommit === deliveredPr.mergeCommit,
			reverifiedAfterTransition: verificationCalls.some((event) => event.phase === 0) && verificationCalls.some((event) => event.phase === 1)
				&& verification.localMain === deliveredRefs.localMain && verification.originMain === deliveredRefs.originMain
				&& verification.prHead === deliveredRefs.prHead && verification.remoteDelivered === true && verification.prMerged === true,
		};
	}

	const finalBody = output.files["config.json"] ?? "";
	const finalDigest = createHash("sha256").update(finalBody).digest("hex");
	const initialRequirementsDigest = createHash("sha256").update(item.fixture.files["requirements.json"] ?? "").digest("hex");
	const finalRequirementsBody = output.generated["requirements.json"] ?? "";
	const finalRequirementsDigest = createHash("sha256").update(finalRequirementsBody).digest("hex");
	const ledger = (output.generated["gate-runs.jsonl"] ?? "").trim().split("\n").filter(Boolean).map(object);
	const full = ledger.filter((record) => record.mode === "full");
	const successfulFull = full.filter((record) => record.passed === true);
	const initialFull = successfulFull.find((record) => record.requirementsDigest === initialRequirementsDigest);
	const finalFull = successfulFull.find((record) => record.requirementsDigest === finalRequirementsDigest && record.configDigest === finalDigest);
	const config = object(finalBody);
	const requirements = object(finalRequirementsBody);
	const verification = object(output.generated["verification.json"] ?? "");
	const reports = output.phaseReports.map(object);
	return {
		requirementsTransitioned: requirements.mode === finalRequirements.mode && requirements.batchSize === finalRequirements.batchSize
			&& JSON.stringify(requirements.checks) === JSON.stringify(finalRequirements.checks) && initialRequirementsDigest !== finalRequirementsDigest,
		finalConfigCorrect: config.mode === finalRequirements.mode && config.batchSize === finalRequirements.batchSize
			&& JSON.stringify(config.checks) === JSON.stringify(finalRequirements.checks),
		eachCompletedCandidateVerified: initialFull !== undefined && finalFull !== undefined,
		finalVerificationCurrent: verification.configDigest === finalDigest && verification.requirementsDigest === finalRequirementsDigest && verification.passed === true,
		candidateActuallyChanged: output.editHistory.length >= 2 && initialFull?.configDigest !== finalDigest,
		phaseReportsTrackTheirCandidate: reports[0]?.case === item.id && reports[0]?.gate === "passed" && reports[0]?.candidateDigest === initialFull?.configDigest
			&& answer.gate === "passed" && answer.candidateDigest === finalDigest,
	};
}
