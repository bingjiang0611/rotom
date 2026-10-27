import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";
import { REPLAY_KEEP_RECENT, REPLAY_PRODUCT, REPLAY_TASKS, REPLAY_THRESHOLD, writeReplayFixture } from "../src/compaction-offload-cases.ts";
import { createReplayMetrics, OFFLOAD_ENTRY, readOffloadDecisions } from "../src/compaction-offload-metrics.ts";

afterEach(() => vi.unstubAllGlobals());

it("rotom defaults compose offload, Action Fusion edits and exact recall without a reducer", async () => {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("This faux regression forbids network"); }));
	const task = REPLAY_TASKS[0]!;
	const model = { provider: "rotom-fusion-offload-faux", id: "compatibility" };
	const metrics = createReplayMetrics();
	let requests = 0, firstReadText = "", firstEditText = "";
	let fileRecallChecked = false, editRecallChecked = false;
	const text = (message: any): string => typeof message.content === "string" ? message.content :
		message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
	const harness = createPiCodingAgentHarness({
		name: "default-fusion-offload", productAgentDir: REPLAY_PRODUCT,
		piExecutable: resolve(REPLAY_PRODUCT, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
		model, tools: ["read", "edit", "write", "obs_recall"],
		environment: { ROTOM_COMPACTION_OFFLOAD: undefined, PI_CODING_AGENT_DIR: undefined },
		inlineExtensions: [metrics.extension], inlineExtensionsFirst: true,
		async setupWorkspace({ workspace, configDir }) {
			process.env.PI_CODING_AGENT_DIR = configDir;
			await writeReplayFixture(workspace, task);
			await writeFile(join(workspace, "edit-target.txt"), "before\n");
		},
		async modelRuntimeFactory({ product, configDir }) {
			const { createJiti } = await import(pathToFileURL(resolve(REPLAY_PRODUCT, "runtime/pi/node_modules/jiti/lib/jiti.mjs")).href);
			const jiti = createJiti(product.verified.publicEntry, { moduleCache: false,
				alias: { "@earendil-works/pi-coding-agent": product.verified.publicEntry } });
			const { loadRotomSolPiConfig, ROTOM_SOL_PI_DEFAULT_CONFIG } = await jiti.import(resolve(REPLAY_PRODUCT, "extensions/third-party/sol-pi.ts"));
			const workspace = resolve(configDir, "../workspace");
			expect(existsSync(join(configDir, "sol-pi.json"))).toBe(false);
			expect(existsSync(join(workspace, ".pi/sol-pi.json"))).toBe(false);
			const defaults = loadRotomSolPiConfig({ cwd: workspace, isProjectTrusted: () => true }, configDir);
			expect(defaults).toBe(ROTOM_SOL_PI_DEFAULT_CONFIG);
			expect(defaults).toMatchObject({ actionFusion: true, observationPack: true, compactionOffload: true,
				evidencePreservingReducer: true, onlineContextCompact: false });
			// Derive the real no-file defaults first. The isolated config changes only
			// Reducer, so the normal product wrapper loads the full combination safely.
			await writeFile(join(configDir, "sol-pi.json"), JSON.stringify({ ...defaults, evidencePreservingReducer: false }));
			await writeFile(join(configDir, "settings.json"), JSON.stringify({ retry: { enabled: false },
				compaction: { enabled: true, reserveTokens: 256_000 - REPLAY_THRESHOLD, keepRecentTokens: REPLAY_KEEP_RECENT } }));
			const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(resolve(product.verified.packageRoot, "../pi-ai/dist/providers/faux.js")).href);
			const { getCurrentTools, getCurrentSystemPrompt } = await import(pathToFileURL(resolve(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
			const faux = fauxProvider({ provider: model.provider, models: [{ id: model.id, contextWindow: 256_000, maxTokens: 4096 }] });
			let reads = 0, pressure = 0, stage = 0;
			const call = (name: string, args: object, id: string) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
			const response = (context: any, options: any) => {
				requests++;
				options.cacheRetention = "none";
				expect(getCurrentSystemPrompt(context.messages)).not.toContain("context summarization assistant");
				const editTool = getCurrentTools(context.messages).find((tool: any) => tool.name === "edit");
				expect(editTool.parameters.properties).toHaveProperty("then_run");
				const results = context.messages.filter((m: any) => m.role === "toolResult");
				for (const result of results) expect(result.isError).not.toBe(true);
				const readResult = results.find((m: any) => m.toolCallId === "read-0");
				if (!firstReadText && readResult) {
					firstReadText = text(readResult);
					expect(firstReadText).toContain(task.files[task.reading[0]!]!);
				}
				const editResult = results.find((m: any) => m.toolCallId === "edit-one");
				if (!firstEditText && editResult) {
					firstEditText = text(editResult);
					expect(editResult.details.actionFusion).toMatchObject({ mutation: "applied", followup: "succeeded" });
					expect(firstEditText).toContain("[then_run:succeeded]");
					expect(Buffer.byteLength(firstEditText)).toBeGreaterThan(1536);
					expect(Buffer.byteLength(firstEditText)).toBeLessThan(10 * 1024);
				}
				if (reads < task.reading.length) {
					const start = reads; reads = Math.min(reads + 10, task.reading.length);
					return fauxAssistantMessage(task.reading.slice(start, reads).map((path, i) =>
						fauxToolCall("read", { path }, { id: `read-${start + i}` })), { stopReason: "toolUse" });
				}
				if (stage === 0) {
					stage++;
					expect(text(readResult)).toContain("offloaded before compaction");
					return call("edit", { path: "edit-target.txt", edits: [{ oldText: "before\n", newText: "one\n" }],
						then_run: { command: `node -e "if(require('node:fs').readFileSync('edit-target.txt','utf8')!=='one\\n')process.exit(1);process.stdout.write('fusion-local-check\\n'.repeat(140))"`, timeout: 5 } }, "edit-one");
				}
				if (stage === 1) {
					stage++;
					const id = text(readResult).match(/obs_[a-f0-9]{24}/u)![0];
					return call("obs_recall", { id, offset: 0 }, "recall-file");
				}
				if (!fileRecallChecked) {
					expect(text(results.find((m: any) => m.toolCallId === "recall-file"))).toContain(firstReadText);
					fileRecallChecked = true;
				}
				// Age the successful medium-sized Action Fusion result through another
				// threshold. Pure-text edit receipts ARE eligible; verify recall, not an
				// invented exclusion, and perform a second real edit after projection.
				if (pressure < 60) {
					const start = pressure; pressure += 10;
					return fauxAssistantMessage(task.reading.slice(start, pressure).map((path, i) =>
						fauxToolCall("read", { path }, { id: `pressure-${start + i}` })), { stopReason: "toolUse" });
				}
				if (stage === 2) {
					stage++;
					expect(text(editResult)).toContain("offloaded before compaction");
					return call("edit", { path: "edit-target.txt", edits: [{ oldText: "one\n", newText: "two\n" }],
						then_run: { command: `node -e "if(require('node:fs').readFileSync('edit-target.txt','utf8')!=='two\\n')process.exit(1);console.log('second-edit-ok')"`, timeout: 5 } }, "edit-two");
				}
				if (stage === 3) {
					stage++;
					return call("obs_recall", { id: text(editResult).match(/obs_[a-f0-9]{24}/u)![0], offset: 0 }, "recall-edit");
				}
				expect(text(results.find((m: any) => m.toolCallId === "recall-edit"))).toContain(firstEditText);
				editRecallChecked = true;
				return fauxAssistantMessage("DONE");
			};
			faux.setResponses(Array.from({ length: 40 }, () => response));
			const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
			runtime.registerNativeProvider(faux.provider);
			return runtime;
		},
		async output({ session, workspace, response }) {
			expect(response).toBe("DONE");
			expect(await readFile(join(workspace, "edit-target.txt"), "utf8")).toBe("two\n");
			const branch = session.sessionManager.getBranch();
			const offloaded = branch.flatMap((entry: any) => entry.type === "custom" && entry.customType === OFFLOAD_ENTRY ? entry.data.toolCallIds : []);
			expect(offloaded).toContain("edit-one");
			const second = branch.find((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "edit-two") as any;
			expect(second.message.details.actionFusion).toMatchObject({ mutation: "applied", followup: "succeeded" });
			const decisions = await readOffloadDecisions(session.sessionManager.getSessionDir(), session.sessionManager.getSessionId());
			return metrics.output(branch, true, false, decisions);
		},
	});
	const result = await harness.run("Verify the local fixture with the scripted tool sequence.", { artifacts: {}, setArtifact() {} });
	expect(result.output.deferred).toBeGreaterThanOrEqual(2);
	expect(result.output.nativeCompactions).toBe(0);
	expect(result.output.recalls).toHaveLength(2);
	expect(result.output.recalls.every(recall => recall.offloaded && recall.resultError === false)).toBe(true);
	expect(fileRecallChecked && editRecallChecked).toBe(true);
	expect(fetch).not.toHaveBeenCalled();
	console.log(JSON.stringify({ fusionOffload: { requests, deferred: result.output.deferred, native: result.output.nativeCompactions, recalls: result.output.recalls } }));
}, 120_000);
