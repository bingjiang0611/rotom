import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_FOOTPRINT_SCHEMA_V1, measureContextFootprint } from "./context-footprint.mjs";
import {
	buildContextFootprintReport,
	gitIdentity,
	CURRENT_RUNTIME_CONTEXT_CONTRACT_V1,
	FULL_TOOL_CONTEXT_CONTRACT_V1,
	REFERENCE_CONTEXT_FOOTPRINT_V1,
} from "./report-context-footprint.mjs";

const tools = [
	{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } }, promptGuidelines: ["Use read."] },
	{ name: "browser_inspect", description: "Browser", parameters: { type: "object", properties: { operation: { type: "string" } } }, promptGuidelines: ["Use browser_inspect."] },
	{ name: "mystery", description: "Unknown", parameters: { type: "object", properties: {} } },
];

function measurement(activeToolNames) {
	return measureContextFootprint({
		systemPrompt: "system prompt",
		allTools: tools,
		activeToolNames,
		contextFiles: [{ path: "/repo/AGENTS.md", content: "rules" }],
		skills: [{ name: "skill", description: "Use for fixtures", filePath: "/skills/skill/SKILL.md" }],
	});
}

test("clean initial repository reports unavailable history instead of a fabricated diff", () => {
	const root = mkdtempSync(join(tmpdir(), "rotom-footprint-git-"));
	try {
		const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", root, ...args], { stdio: "pipe" });
		git("init", "--initial-branch=main");
		git("config", "user.name", "Fixture");
		git("config", "user.email", "fixture@users.noreply.github.com");
		mkdirSync(join(root, "rotom"));
		writeFileSync(join(root, "README.md"), "public fixture\n");
		git("add", "README.md");
		git("commit", "-m", "initial fixture");
		const identity = gitIdentity(join(root, "rotom"));
		assert.equal(identity.referenceCommitAvailable, false);
		assert.equal(identity.referenceChangedFiles, null);
		assert.equal(identity.dirty, false);
		assert.equal(identity.branch, "main");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("footprint report is deterministic, grouped, and labels token counts as a proxy", () => {
	const first = measurement(["read", "browser_inspect", "mystery"]);
	const second = measurement(["read", "browser_inspect", "mystery"]);
	assert.deepEqual(first, second);
	assert.equal(first.schema, CONTEXT_FOOTPRINT_SCHEMA_V1);
	assert.equal(first.activeToolCount, 3);
	assert.equal(first.contextFiles.contentBytes, Buffer.byteLength("rules"));
	assert.equal(first.skillCatalog.entries[0].name, "skill");
	assert.match(first.measurement.approximateTokenProxy, /not provider-exact/u);
	assert.deepEqual(first.groups.map(({ group }) => group), ["core", "Browser", "Unclassified"]);
	assert.equal(first.systemPromptSha256.length, 64);
});

test("footprint identifies repeated metadata without treating it as prompt duplication or savings", () => {
	const input = { systemPrompt: "", activeToolNames: ["read", "bash"], allTools: [
		{ name: "read", description: "Read", parameters: {}, promptGuidelines: ["private repeated guideline"] },
		{ name: "bash", description: "Bash", parameters: {}, promptGuidelines: ["private repeated guideline"] },
		{ name: "inactive", description: "Inactive", parameters: {}, promptGuidelines: ["private repeated guideline"] },
	] };
	const report = measureContextFootprint(input);
	assert.equal(report.repeatedGuidelines.length, 1);
	assert.equal(report.repeatedGuidelines[0].occurrences, 2);
	assert.equal(report.repeatedGuidelines[0].repeatedMetadataBytes, Buffer.byteLength("private repeated guideline"));
	assert.doesNotMatch(JSON.stringify(report), /private repeated/u);
	assert.match(report.measurement.repeatedGuidelines, /Pi may deduplicate/u);
	assert.notEqual(measureContextFootprint({ ...input, activeToolNames: ["bash", "read"] }).activeToolNamesSha256, report.activeToolNamesSha256);
	assert.equal(report.tools.find((tool) => tool.name === "read").descriptionBytes, 4);
	assert.equal(report.tools.find((tool) => tool.name === "read").parameterSchemaBytes, 2);
});

test("runtime report enforces the default deferred contract without rewriting the immutable reference", () => {
	const current = {
		...measurement(["read"]),
		activeToolCount: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolCount,
		activeToolSchemaBytes: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolSchemaBytes,
		activeToolGuidelineBytes: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolGuidelineBytes,
	};
	const report = buildContextFootprintReport({ runtime: { contextFootprint: current, deferredToolsEnabled: true }, identity: { git: { head: "abc" } }, elapsedMs: 12 });
	assert.equal(report.schema, "dev-agent-context-footprint-report/v3");
	assert.equal(report.deferredToolsEnabled, true);
	assert.equal(report.runtimeContractGate, "PASS");
	assert.equal(report.referenceObservationGate, "DRIFT");
	assert.equal(report.referenceDifference.activeToolSchemaBytes, CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolSchemaBytes - REFERENCE_CONTEXT_FOOTPRINT_V1.activeToolSchemaBytes);
	assert.equal(report.deterministicGate, "PASS");
	assert.equal(report.measurement.realModelCalls, 0);
});

test("explicit opt-out full tool surface has an independent reviewed contract", () => {
	const current = {
		...measurement(["read", "browser_inspect", "mystery"]),
		activeToolCount: FULL_TOOL_CONTEXT_CONTRACT_V1.activeToolCount,
		activeToolSchemaBytes: FULL_TOOL_CONTEXT_CONTRACT_V1.activeToolSchemaBytes,
		activeToolGuidelineBytes: FULL_TOOL_CONTEXT_CONTRACT_V1.activeToolGuidelineBytes,
	};
	const report = buildContextFootprintReport({ runtime: { contextFootprint: current, deferredToolsEnabled: false }, identity: { git: { head: "full-opt-out" } }, elapsedMs: 3 });
	assert.equal(report.deferredToolsEnabled, false);
	assert.equal(report.runtimeContract, FULL_TOOL_CONTEXT_CONTRACT_V1);
	assert.equal(report.runtimeContractGate, "PASS");
	assert.equal(report.referenceObservationGate, "DRIFT");
});

test("omitting the three stable Goal schemas fails both startup contracts", () => {
	for (const [deferredToolsEnabled, contract] of [[true, CURRENT_RUNTIME_CONTEXT_CONTRACT_V1], [false, FULL_TOOL_CONTEXT_CONTRACT_V1]]) {
		const contextFootprint = {
			...measurement(["read"]),
			activeToolCount: contract.activeToolCount - 3,
			activeToolSchemaBytes: contract.activeToolSchemaBytes - 2_951,
			activeToolGuidelineBytes: contract.activeToolGuidelineBytes - 6,
		};
		const report = buildContextFootprintReport({ runtime: { contextFootprint, deferredToolsEnabled }, identity: {}, elapsedMs: 0 });
		assert.equal(report.runtimeContractGate, "REGRESSION");
		assert.deepEqual(report.contract, { activeToolCount: false, activeToolSchemaBytes: false, activeToolGuidelineBytes: false });
	}
});

test("unreviewed guideline drift remains visible and fails the current runtime contract", () => {
	const current = {
		...measurement(["read"]),
		activeToolCount: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolCount,
		activeToolSchemaBytes: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolSchemaBytes,
		activeToolGuidelineBytes: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolGuidelineBytes + 1,
	};
	const report = buildContextFootprintReport({ runtime: { contextFootprint: current, deferredToolsEnabled: true }, identity: { git: { head: "new-main", referenceChangedFiles: ["subagent-policy.ts"] } }, elapsedMs: 1 });
	assert.equal(report.referenceObservation.activeToolGuidelineBytes, 18_847);
	assert.equal(report.referenceDifference.activeToolGuidelineBytes, CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolGuidelineBytes + 1 - REFERENCE_CONTEXT_FOOTPRINT_V1.activeToolGuidelineBytes);
	assert.equal(report.referenceObservationGate, "REGRESSION");
	assert.equal(report.runtimeContractGate, "REGRESSION");
	assert.equal(report.deterministicGate, "REGRESSION");
});

test("unexpected schema drift still fails the deterministic gate", () => {
	const current = {
		...measurement(["read"]),
		activeToolCount: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolCount,
		activeToolSchemaBytes: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolSchemaBytes + 1,
		activeToolGuidelineBytes: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.activeToolGuidelineBytes,
	};
	const report = buildContextFootprintReport({ runtime: { contextFootprint: current, deferredToolsEnabled: true }, identity: { git: { head: "unexpected" } }, elapsedMs: 1 });
	assert.equal(report.runtimeContractGate, "REGRESSION");
	assert.equal(report.deterministicGate, "REGRESSION");
});
