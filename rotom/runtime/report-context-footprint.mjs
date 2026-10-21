#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REFERENCE_CONTEXT_FOOTPRINT_V1 = {
	gitHead: "97077bed223a1892aae93151c39d9d9fc3868900",
	activeToolCount: 44,
	activeToolSchemaBytes: 62_014,
	activeToolGuidelineBytes: 18_847,
	referenceSystemPromptBytes: 27_314,
};

// Shared Codemode description: +164 UTF-8 bytes for the Pi 1.1 async/output
// guidance; Pi 1.1.0-rotom.2 restores upstream classifier wording (-2 vs the
// former image-only wording). Optional compact shell output adds
// 352 schema bytes and 227 guideline bytes, measured on default/full/scoped SDK smoke.
// The Codemode guideline that scripts call only Codemode-callable tools adds
// 167 guideline bytes, measured on default/full/scoped SDK smoke.
// Pi 1.3.0 states that a tool declaring an object result resolves on failure
// too (+115 schema bytes); measured against the 1.1.0-rotom.2 runtime with the
// same extensions on default and full SDK smoke, after path normalization.
// The full/scoped contracts also absorb the -202 bytes from the shortened
// Subagent descriptions (32029b3), which only changed the deferred group.
// Bundled SoL-Pi defaults (Action Fusion + Observation Pack) add obs_recall
// (+1 tool, 320 schema bytes, 2 guideline bytes) and replace the builtin
// edit/write schemas (+923 schema bytes), +1,243 normalized schema bytes in
// total on default/full/scoped SDK smoke.
// Context Layers adds three model-only tools: 1,833 schema bytes and 598
// guideline bytes, including cache-aware compression guidance (+151 bytes),
// measured against the opt-out control in real SDK smoke.
// Preserve this checkout's Subagent contract; these are bytes, not provider tokens.
const CONTEXT_LAYERS_FOOTPRINT = { activeToolCount: 3, activeToolSchemaBytes: 1_833, activeToolGuidelineBytes: 598 };
export const CURRENT_RUNTIME_CONTEXT_CONTRACT_V1 = {
	// Four stable Goal schemas, including explicit continuation. Measured by
	// real SDK smoke, including the shared Browser expectation enum and operation
	// parameter requirements; static bytes are not provider tokens.
	activeToolCount: 28,
	activeToolSchemaBytes: 26_184,
	activeToolGuidelineBytes: 10_095,
	schemaPathNormalization: "Codemode documentation path -> <pi-docs>/codemode.md; current measurements remain raw bytes",
	note: "The default product surface keeps core (edit/write from bundled SoL-Pi Action Fusion), SoL-Pi obs_recall, Codemode, Ask, Browser/Computer Use, the four stable Goal schemas, Context Layers, and search_tools active while deferring only the retained Subagent group. Visible Goal schemas do not authorize Goal execution without an active Goal. Guideline bytes include the product's observe_ui/read_text/act_ui/wait_for/search_ui contract guidelines, which state the real per-call focus scope, condition combinations, observe-first requirement, untrusted status of observed screen text, structured-interface-first routing, and the dispatch-versus-effect evidence ladder of the Computer Use package, plus the browser relay's ref-bound Enter/Tab/Escape keypress, target-state/page-alert evidence and no-replay boundary for unknown writes. Includes Relay-first launch_browser fallback metadata, HTTP-only local-page guidance, isolated-login disclosure and pre-dispatch/no-replay boundaries; measured static bytes are not provider tokens.",
};

export const FULL_TOOL_CONTEXT_CONTRACT_V1 = {
	activeToolCount: 29,
	activeToolSchemaBytes: 38_265,
	activeToolGuidelineBytes: 10_746,
	schemaPathNormalization: CURRENT_RUNTIME_CONTEXT_CONTRACT_V1.schemaPathNormalization,
	note: "ROTOM_DEFERRED_TOOLS=0 restores the reviewed full startup surface for retained product tools, including the four stable Goal schemas and Context Layers. This contract is for an unscoped maintenance load; Measured with the Browser keypress schema, Relay-first isolated-browser fallback metadata and compact descriptions, after removing the enterprise platform extensions and bundled skills; the default deferred surface only routes Subagent. These are static bytes, not provider tokens. Retired capabilities stay absent even with deferred loading disabled.",
};

// Measured with pi-subagents .4: product-owned descriptions/guidelines replace
// inherited metadata; scoped schemas omit unavailable fields. Not token savings.
export const SCOPED_FULL_TOOL_CONTEXT_CONTRACT_V1 = {
	...FULL_TOOL_CONTEXT_CONTRACT_V1,
	activeToolSchemaBytes: 37_489,
	activeToolGuidelineBytes: 11_381,
	note: "Full startup surface under the product owned-process-groups-v2 Subagent scope, with four stable Goal schemas. Static bytes, not provider tokens.",
};

function runSmoke(piExecutable, agentDir) {
	const started = performance.now();
	const result = spawnSync(process.execPath, [resolve(agentDir, "runtime/smoke-runtime.mjs"), piExecutable, agentDir], {
		cwd: resolve(agentDir, ".."),
		encoding: "utf8",
		timeout: 300_000,
		maxBuffer: 8 * 1024 * 1024,
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`runtime smoke failed (${result.status}): ${result.stderr || result.stdout}`);
	return { elapsedMs: performance.now() - started, result: JSON.parse(result.stdout.trim()) };
}

export function gitIdentity(agentDir) {
	const repository = resolve(agentDir, "..");
	const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
	const head = git("rev-parse", "HEAD");
	const probe = spawnSync("git", ["-C", repository, "rev-parse", "--verify", "--quiet", `${REFERENCE_CONTEXT_FOOTPRINT_V1.gitHead}^{commit}`], { encoding: "utf8" });
	if (probe.error) throw probe.error;
	if (probe.status !== 0 && probe.status !== 1) throw new Error("Cannot inspect reference commit availability");
	const referenceCommitAvailable = probe.status === 0;
	// A clean release repository deliberately has no private maintenance history.
	// Keep the saved measurement, but do not invent an empty historical diff.
	const referenceChangedFiles = referenceCommitAvailable ? git("diff", "--name-only", `${REFERENCE_CONTEXT_FOOTPRINT_V1.gitHead}..${head}`).split("\n").filter(Boolean) : null;
	return { head, branch: git("branch", "--show-current") || null, dirty: git("status", "--porcelain=v1").length > 0, referenceCommitAvailable, referenceChangedFiles };
}

export function buildContextFootprintReport({ runtime, identity, elapsedMs }) {
	const footprint = runtime.contextFootprint;
	const deferredToolsEnabled = runtime.deferredToolsEnabled === true;
	const contextLayersEnabled = runtime.contextLayersEnabled !== false;
	let selectedRuntimeContract = deferredToolsEnabled ? CURRENT_RUNTIME_CONTEXT_CONTRACT_V1 : runtime.subagentExecutionScope === "owned-process-groups-v2" ? SCOPED_FULL_TOOL_CONTEXT_CONTRACT_V1 : FULL_TOOL_CONTEXT_CONTRACT_V1;
	// Only an explicit opt-out selects the smaller contract. Inferring it from
	// missing tools would conceal a broken default-enabled registration.
	if (!contextLayersEnabled) {
		selectedRuntimeContract = { ...selectedRuntimeContract,
			activeToolCount: selectedRuntimeContract.activeToolCount - CONTEXT_LAYERS_FOOTPRINT.activeToolCount,
			activeToolSchemaBytes: selectedRuntimeContract.activeToolSchemaBytes - CONTEXT_LAYERS_FOOTPRINT.activeToolSchemaBytes,
			activeToolGuidelineBytes: selectedRuntimeContract.activeToolGuidelineBytes - CONTEXT_LAYERS_FOOTPRINT.activeToolGuidelineBytes,
			note: `${selectedRuntimeContract.note} Context Layers explicitly disabled; its measured tool metadata is excluded.`,
		};
	}
	const normalizedToolSchemaBytes = footprint.activeToolSchemaBytes - (runtime.toolSchemaPathOverheadBytes ?? 0);
	const contract = {
		activeToolCount: footprint.activeToolCount === selectedRuntimeContract.activeToolCount,
		activeToolSchemaBytes: normalizedToolSchemaBytes === selectedRuntimeContract.activeToolSchemaBytes,
		activeToolGuidelineBytes: footprint.activeToolGuidelineBytes === selectedRuntimeContract.activeToolGuidelineBytes,
	};
	const runtimeContractGate = contract.activeToolCount && contract.activeToolSchemaBytes && contract.activeToolGuidelineBytes ? "PASS" : "REGRESSION";
	const matchesReference = footprint.activeToolCount === REFERENCE_CONTEXT_FOOTPRINT_V1.activeToolCount
		&& footprint.activeToolSchemaBytes === REFERENCE_CONTEXT_FOOTPRINT_V1.activeToolSchemaBytes
		&& footprint.activeToolGuidelineBytes === REFERENCE_CONTEXT_FOOTPRINT_V1.activeToolGuidelineBytes;
	const referenceObservationGate = runtimeContractGate === "REGRESSION" ? "REGRESSION" : matchesReference ? "PASS" : "DRIFT";
	return {
		schema: "dev-agent-context-footprint-report/v3",
		identity,
		measurement: { realModelCalls: 0, fauxProviderCalls: runtime.fauxProviderCalls ?? null, networkRequired: false, providerExactTokens: false, elapsedMs, normalizedToolSchemaBytes },
		referenceObservation: REFERENCE_CONTEXT_FOOTPRINT_V1,
		deferredToolsEnabled,
		contextLayersEnabled,
		runtimeContract: selectedRuntimeContract,
		referenceDifference: {
			systemPromptBytes: footprint.systemPromptBytes - REFERENCE_CONTEXT_FOOTPRINT_V1.referenceSystemPromptBytes,
			activeToolCount: footprint.activeToolCount - REFERENCE_CONTEXT_FOOTPRINT_V1.activeToolCount,
			activeToolSchemaBytes: footprint.activeToolSchemaBytes - REFERENCE_CONTEXT_FOOTPRINT_V1.activeToolSchemaBytes,
			activeToolGuidelineBytes: footprint.activeToolGuidelineBytes - REFERENCE_CONTEXT_FOOTPRINT_V1.activeToolGuidelineBytes,
			note: "The saved reference is immutable. System-prompt bytes vary with absolute path length; Pi/runtime and guideline changes remain explicit drift against that reference.",
		},
		contract,
		runtimeContractGate,
		referenceObservationGate,
		current: footprint,
		deterministicGate: runtimeContractGate,
	};
}

async function main() {
	const [piExecutable, agentDirInput] = process.argv.slice(2);
	if (!piExecutable || !agentDirInput) throw new Error("usage: report-context-footprint.mjs <pi-executable> <agent-dir>");
	if (!isAbsolute(piExecutable)) throw new Error("pi executable must be absolute");
	const agentDir = resolve(agentDirInput);
	const started = performance.now();
	const runtime = runSmoke(piExecutable, agentDir);
	const report = buildContextFootprintReport({ runtime: runtime.result, identity: { git: gitIdentity(agentDir), pi: { executable: piExecutable, version: runtime.result.version } }, elapsedMs: performance.now() - started });
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (report.deterministicGate !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
