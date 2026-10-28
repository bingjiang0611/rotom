import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultProductAgentDir } from "../src/product-runtime.ts";
import { createPiCodingAgentHarness, DEV_AGENT_RUN_MANIFEST_ARTIFACT } from "../src/pi-harness.ts";
import { afterEach, describe, expect, it } from "vitest";
import { inspectQualityTask, qualityRegressionTasks, setupQualityTask } from "../src/quality-regressions.ts";

// Reference repairs are test-only: never copied into a model's workspace.
const repairs: Record<string, string> = {
	"finish-all-stages": "export function normalize(values){return values.map(value=>value.trim().toLowerCase());}\nexport function render(values){return normalize(values).join(',');}\n",
	"check-real-connection-path": "export function chooseConnection(config){return config.multiplex.available?'multiplex':config.direct.available?'direct':null;}\n",
	"add-without-replacing": '{"default":"model-stable","models":[{"id":"model-stable","budget":42},{"id":"model-legacy"},{"id":"model-next"}]}\n',
	"structured-write-evidence": "export function applied(event){const phase=event.details?.actionFusion;return phase?.version===1&&phase.mutation==='applied';}\n",
	"version-not-a-historical-mention": "export function matchesCurrent(document,version){const lines=document.split('\\n').filter(line=>line.startsWith('Current baseline:'));return lines.length===1&&lines[0]==='Current baseline: '+version;}\n",
	"optional-schema-isolation": "export function register(nativeAsk,registry,warn){if(nativeAsk.schemaVersion===1)registry.add({...nativeAsk,continuation:true});else{warn('unsupported schema');registry.add(nativeAsk);}registry.add({name:'later'});}\n",
	"authenticated-cli-success-path": "export function decode(frame){return frame.type==='tool_call'?{kind:'tool',name:frame.name}:{kind:'result',text:frame.text};}\n",
	"warning-channel-boundary": "export function reportMissing(message,ctx){if(ctx.hasUI)ctx.ui.notify(message,'warning');else process.emitWarning(message,{code:'MISSING_TOOL'});}\n",
};

const workspaces: string[] = [];
afterEach(async () => { await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

for (const task of qualityRegressionTasks) describe(task.id, () => {
	async function workspace() {
		const path = await mkdtemp(join(tmpdir(), "rotom-quality-case-"));
		workspaces.push(path);
		await setupQualityTask(task, path);
		return path;
	}

	it("rejects the historical failure, even with an unchanged test harness", async () => {
		const result = await inspectQualityTask(task, await workspace());
		expect(result.scopePreserved).toBe(true);
		expect(result.acceptancePassed).toBe(false);
		expect(result.diagnostic).toMatch(task.id === "optional-schema-isolation" ? /schema mismatch/u : /AssertionError/u);
	});

	it("accepts an actual repair and preserves unrelated files", async () => {
		const path = await workspace();
		await writeFile(join(path, task.editable), repairs[task.id]!);
		const result = await inspectQualityTask(task, path);
		expect(result, result.diagnostic).toMatchObject({ scopePreserved: true, acceptancePassed: true, exitCode: 0 });
	});

	it("rejects a green but emptied test instead of trusting agent-reported success", async () => {
		const path = await workspace();
		await writeFile(join(path, "test.mjs"), "console.log('all tests pass');\n");
		expect(spawnSync(process.execPath, ["test.mjs"], { cwd: path }).status).toBe(0);
		const result = await inspectQualityTask(task, path);
		expect(result).toMatchObject({ scopePreserved: false, acceptancePassed: false });
	});
});

it.each(["succeeded", "failed"] as const)("a real write with %s follow-up keeps mutation and validation evidence separate", async (followup) => {
	const task = qualityRegressionTasks.find(task => task.id === "add-without-replacing")!;
	const productDir = defaultProductAgentDir();
	const piPackage = join(productDir, "runtime/pi/node_modules/@earendil-works/pi-coding-agent");
	const metadata = JSON.parse(await readFile(join(piPackage, "package.json"), "utf8"));
	const harness = createPiCodingAgentHarness({
		name: "quality-artifact-smoke",
		model: { provider: "quality-fixture", id: "fixture" },
		productAgentDir: productDir,
		piExecutable: join(piPackage, metadata.bin.pi),
		tools: ["write", "read"],
		environment: { ROTOM_QODER: "0", ROTOM_OBSERVABILITY: "0" },
		async setupWorkspace({ workspace, configDir }) {
			await setupQualityTask(task, workspace);
			await writeFile(join(configDir, "sol-pi.json"), JSON.stringify({ evidencePreservingReducer: false }));
		},
		async modelRuntimeFactory({ product, configDir }) {
			const piAiEntry = join(product.verified.packageRoot, "../pi-ai/dist/index.js");
			const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(pathToFileURL(piAiEntry).href);
			const faux = fauxProvider({ provider: "quality-fixture", models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 1024 }] });
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: task.editable, content: repairs[task.id], then_run: { command: `node -e "process.exit(${followup === "failed" ? 7 : 0})"`, timeout: 5 } }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("read", { path: task.editable }), { stopReason: "toolUse" }),
				fauxAssistantMessage("fixture completed"),
			]);
			const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
			runtime.registerNativeProvider(faux.provider);
			return runtime;
		},
		async output({ workspace, session }) {
			const results = session.messages.filter(message => message.role === "toolResult");
			const writes = results.filter(message => message.toolName === "write");
			expect(writes).toHaveLength(1);
			expect(writes[0]).toMatchObject({ isError: followup === "failed", details: {
				actionFusion: { version: 1, mutation: "applied", followup },
				codingPhases: { mutation: "applied", followup, source: "tool-reported" },
			} });
			expect(results.some(message => message.toolName === "read" && !message.isError)).toBe(true);
			return inspectQualityTask(task, workspace);
		},
	});
	const artifacts: Record<string, unknown> = {};
	const result = await harness.run(task.prompt, { artifacts: {}, setArtifact(name, value) { artifacts[name] = value; } });
	expect(result.output).toMatchObject({ acceptancePassed: true, scopePreserved: true });
	expect(artifacts[DEV_AGENT_RUN_MANIFEST_ARTIFACT]).toBeDefined();
	expect(result.session.events).toContainEqual({ type: "message", role: "assistant", content: "fixture completed" });
}, 60_000);

it("rejects a CLI that passes init and signed-out checks but fails the signed-in task", async () => {
	const task = qualityRegressionTasks.find(task => task.id === "authenticated-cli-success-path")!;
	const path = await mkdtemp(join(tmpdir(), "rotom-quality-cli-"));
	workspaces.push(path);
	await setupQualityTask(task, path);
	const run = (...args: string[]) => spawnSync(process.execPath, ["client.mjs", ...args], { cwd: path, encoding: "utf8" });
	expect(run("init").status).toBe(0);
	expect(run("run", "signed-out.json", "result.json").status).toBe(2);
	expect(run("run", "signed-in.json", "result.json").status).toBe(3);
	expect((await inspectQualityTask(task, path)).acceptancePassed).toBe(false);
});

it("rejects stopping after the first milestone", async () => {
	const task = qualityRegressionTasks[0]!;
	const path = await mkdtemp(join(tmpdir(), "rotom-quality-partial-"));
	workspaces.push(path);
	await setupQualityTask(task, path);
	await writeFile(join(path, task.editable), "export function normalize(values){return values.map(value=>value.trim().toLowerCase());}\nexport function render(values){return '';}\n");
	expect((await inspectQualityTask(task, path)).acceptancePassed).toBe(false);
});
