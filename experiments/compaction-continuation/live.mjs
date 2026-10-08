// Explicitly authorized, fixed-profile diagnostic A/B. No real workspace/external write tools.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { loadProductRuntime } from "../../rotom/evals/src/product-runtime.ts";
import { CASES, SYSTEM, PREVIOUS_SUMMARY, historyFor, createFixture } from "./cases.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function admit(report, chain, now = Date.now()) {
	if (now >= report.deadline || (report.priorRequests ?? 0) + report.requests.length >= 120 || chain.requests >= 6) {
		chain.admissionDenied = true;
		throw new Error("Evaluation admission limit reached; no replay");
	}
	const record = { ordinal: report.requests.length + 1, case: chain.case, repetition: chain.repetition,
		arm: chain.arm, phase: chain.phase, status: "admitted", started: now };
	report.requests.push(record);
	chain.requests++;
	return record;
}

export async function run(baselinePath, candidatePath, outputPath, live, priorReportPath) {
	const priorBytes = priorReportPath ? readFileSync(priorReportPath) : undefined;
	const prior = priorBytes ? JSON.parse(priorBytes) : undefined;
	const repairSummary = prior?.errorClass === "TypeError" && prior.chains.every((c) => !c.grade && c.phase === "summary");
	if (prior) {
		assert(live && prior.status === "BLOCKED" && prior.ended, "Prior process must have finalized its report");
		if (repairSummary) {
			assert(prior.requests.length > 0 && prior.requests.every((r) => r.status === "stop" && r.phase === "summary"));
			assert.equal(prior.priorRequests ?? 0, 0, "No chained summary repair attempts");
		}
		assert.equal(prior.harnessHashes["cases.mjs"], hash(readFileSync(new URL("cases.mjs", import.meta.url))));
	}
	const output = realpathSync(outputPath);
	const reportPath = join(output, live ? "report.json" : "preflight.json");
	const report = { schema: "rotom-compaction-continuation-ab/v1", status: "PREFLIGHT", provider: "openai-codex", model: "gpt-6-astra", thinking: "medium",
		profile: "6 fixed diagnostic cases x 2 repetitions x 2 arms", maxRequests: 120, maxMinutes: 60,
		harnessHashes: Object.fromEntries(["live.mjs", "cases.mjs"].map((name) => [name, hash(readFileSync(new URL(name, import.meta.url)))])),
		started: null, deadline: null, usd: null, requests: [], networkModelDispatches: 0, chains: [], arms: {},
		priorRequests: repairSummary ? prior.requests.length : (prior?.priorRequests ?? 0),
		priorInfrastructureAttempt: repairSummary ? { reportSha256: hash(priorBytes), admittedRequests: prior.requests.length, modelDispatches: prior.networkModelDispatches,
			reportedTokens: prior.requests.reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0), reason: "local harness TypeError after known completed summary; no outcome graded" } : (prior?.priorInfrastructureAttempt ?? null) };
	if (prior && !repairSummary) {
		// Only unstarted slots may run. Keep successes, blocked/unknown slots and their usage; never retry them.
		report.requests = prior.requests;
		report.chains = prior.chains;
		report.networkModelDispatches = prior.networkModelDispatches;
		report.continuedFromReportSha256 = hash(priorBytes);
		for (const chain of report.chains.filter((c) => c.status === "PASS")) {
			const directory = join(resolve(priorReportPath, ".."), `${chain.case}-${chain.repetition}-${chain.arm}`, "sessions");
			const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
			assert.equal(files.length, 1);
			const entries = readFileSync(join(directory, files[0]), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const last = entries.findLast((e) => e.type === "message" && e.message.role === "assistant")?.message;
			if (last?.stopReason === "error" && last.errorMessage?.includes("Evaluation admission limit reached")) {
				chain.originalStatus = chain.status; chain.status = "CENSORED"; chain.admissionDenied = true;
			}
		}
	}
	// A prior run (including unknown) is never silently resumed/replayed.
	writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
	const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
	let active;
	let deadlineTimer;
	const controller = new AbortController();
	const pendingUsage = [];
	const dispatchChannel = channel("undici:request:create");
	const dispatchListener = ({ request }) => {
		if (/\/responses(?:\?|$)/.test(request.path)) {
			report.networkModelDispatches++;
			appendFileSync(join(output, "dispatch.jsonl"), JSON.stringify({ request: report.requests.length, time: Date.now() }) + "\n", { mode: 0o600 });
		}
	};
	try {
		const arms = {};
		for (const [arm, product] of [["baseline", baselinePath], ["candidate", candidatePath]]) {
			const selected = await loadProductRuntime({ agentDir: realpathSync(product),
				piExecutable: join(realpathSync(product), "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js") });
			const sdk = selected.runtime;
			const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false, modelsStorePath: null });
			const model = runtime.getPhysicalModel(report.provider, report.model);
			assert(model && runtime.hasConfiguredAuth(report.provider), "Exact model/auth unavailable; no fallback");
			const ai = await import(pathToFileURL(join(product, "runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js")));
			assert.equal(ai.clampThinkingLevel(model, report.thinking), report.thinking);
			const original = runtime.streamSimple.bind(runtime);
			runtime.streamSimple = (selectedModel, context, options = {}) => {
				assert(live && active?.arm === arm, "Unexpected model dispatch");
				assert.equal(selectedModel.id, report.model);
				assert.equal(selectedModel.provider, report.provider);
				const request = admit(report, active);
				save(); // Persist admission before asking the provider; an uncertain call is not replayed.
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(options.signal ? [options.signal] : [])]);
				const stream = original(selectedModel, context, { ...options, signal, reasoning: report.thinking,
					transport: "sse", maxRetries: 0, maxRetryDelayMs: 0, cacheRetention: "none", maxTokens: 2048,
					onResponse: async (response) => { request.httpStatus = response.status; await options.onResponse?.(response); } });
				pendingUsage.push(stream.result().then((message) => {
					request.status = message.stopReason;
					request.elapsedMs = Date.now() - request.started;
					request.responseModel = message.responseModel ?? message.model;
					if (message.stopReason === "error") {
						const error = message.errorMessage ?? "";
						request.errorCategory = /429|rate.?limit/i.test(error) ? "rate-limit" : /401|403|unauthori[sz]ed|authenticat/i.test(error) ? "auth" : /timeout|timed out|ECONN|fetch failed|network/i.test(error) ? "network" : "provider-error";
						request.errorDigest = hash(error);
					}
					const u = message.usage;
					request.usage = u ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens } : null;
					save();
				}, (error) => { request.status = "unknown"; request.errorClass = error?.constructor?.name; save(); }));
				return stream;
			};
			arms[arm] = { sdk, runtime, model, Type: ai.Type };
			const build = JSON.parse(readFileSync(join(product, "runtime/pi/fork-build.json"), "utf8"));
			report.arms[arm] = { forkVersion: build.version, sourceSha256: build.sourceSha256,
				codingAgentIntegrity: build.artifacts["@earendil-works/pi-coding-agent"].integrity,
				modelIdentityDigest: hash(JSON.stringify(model)) };
		}
		assert.equal(report.arms.baseline.modelIdentityDigest, report.arms.candidate.modelIdentityDigest, "Model definitions differ");
		assert.notEqual(report.arms.baseline.sourceSha256, report.arms.candidate.sourceSha256, "A/B artifacts must differ");
		if (!live) { report.status = "READY"; return report; }
		if (prior) assert.deepEqual(report.arms, prior.arms, "Repair must preserve both artifacts and model identity");
		report.started = prior?.started ?? Date.now(); report.deadline = prior?.deadline ?? report.started + 60 * 60 * 1000; report.status = "RUNNING";
		assert(Date.now() < report.deadline, "Original time budget expired");
		deadlineTimer = setTimeout(() => controller.abort(), report.deadline - Date.now());
		dispatchChannel.subscribe(dispatchListener);
		// Alternate order to reduce simple temporal/cache ordering bias; no best-of selection.
		for (const [caseIndex, testCase] of CASES.entries()) {
			for (let repetition = 1; repetition <= 2; repetition++) {
				const order = (caseIndex + repetition) % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"];
				for (const arm of order) {
					if (report.chains.some((c) => c.case === testCase.id && c.repetition === repetition && c.arm === arm)) continue;
					const { sdk, runtime, model, Type } = arms[arm];
					const chain = { case: testCase.id, route: testCase.route, repetition, arm, phase: "summary", requests: 0, started: Date.now(), status: "RUNNING" };
					report.chains.push(chain); active = chain; save();
					const directory = join(output, `${testCase.id}-${repetition}-${arm}`);
					mkdirSync(directory, { mode: 0o700 });
					const manager = sdk.SessionManager.create(directory, join(directory, "sessions"));
					const history = historyFor(testCase);
					for (const message of history) manager.appendMessage(message);
					let summary;
					if (testCase.route === "branch") {
						const generated = await sdk.generateBranchSummary(manager.getBranch(), { model, streamFn: runtime.streamSimple.bind(runtime), signal: controller.signal });
						assert(generated.summary && !generated.error && !generated.aborted, "Branch summary unavailable");
						summary = generated.summary;
						manager.branchWithSummary(null, summary, undefined, false, generated.usage);
					} else {
						const generated = await sdk.generateSummaryWithUsage(history, model, 3000, undefined, undefined, controller.signal,
							undefined, testCase.route === "update" ? PREVIOUS_SUMMARY : undefined, report.thinking, runtime.streamSimple.bind(runtime));
						summary = generated.text;
						manager.appendCompaction(summary, null, history.reduce((n, message) => n + sdk.estimateTokens(message), 0), undefined, false, generated.usage);
					}
					chain.summaryCharacters = summary.length;
					chain.summarySha256 = hash(summary);
					chain.phase = "continuation"; save();
					// Exercise native persistence/reload, not agent.state assignment.
					const restored = sdk.SessionManager.open(manager.getSessionFile(), join(directory, "sessions"), directory);
					const fixture = createFixture(testCase, Type);
					const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120000 } }, transport: "sse", cacheWarming: "off" });
					const loader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
						noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
						systemPrompt: SYSTEM, extensionFactories: [(pi) => pi.registerTool(fixture.tool)] });
					await loader.reload();
					assert.equal(loader.getExtensions().errors.length, 0);
					const { session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model,
						thinkingLevel: report.thinking, settingsManager: settings, sessionManager: restored, resourceLoader: loader, tools: ["workspace"] });
					try {
						const errors = [];
						await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
						assert.equal(errors.length, 0);
						assert.deepEqual(session.getActiveToolNames(), ["workspace"]);
						await session.prompt("Continue the task from the checkpoint.");
						await Promise.all(pendingUsage);
						const calls = report.requests.filter((r) => r.arm === arm && r.case === testCase.id && r.repetition === repetition);
						if (calls.some((r) => ["error", "aborted", "length", "deferred", "unknown", "admitted"].includes(r.status))) {
							chain.status = "BLOCKED";
							throw new Error("Model chain interrupted; no retry");
						}
						chain.grade = fixture.grade(); chain.actions = fixture.actions;
						const last = session.messages.findLast((m) => m.role === "assistant");
						if (last?.stopReason === "error" && !chain.admissionDenied) throw new Error("Native continuation failed outside provider request");
						chain.status = chain.admissionDenied ? "CENSORED" : chain.grade.pass ? "PASS" : "FAIL";
						chain.elapsedMs = Date.now() - chain.started;
						save();
						console.log(JSON.stringify({ case: chain.case, repetition, arm, status: chain.status, requests: chain.requests }));
					} finally { await session.dispose(); }
				}
			}
			const pairs = report.chains.filter((c) => c.case === testCase.id);
			// Two matched regressions are sufficient to stop; one discordant pair is reported but not over-interpreted.
			if ([1, 2].every((r) => pairs.find((c) => c.arm === "baseline" && c.repetition === r)?.status === "PASS" &&
				pairs.find((c) => c.arm === "candidate" && c.repetition === r)?.status === "FAIL")) {
				report.status = "REGRESSION"; return report;
			}
		}
		report.status = "INCONCLUSIVE"; // Small synthetic diagnostics cannot establish broad benefit/non-inferiority.
		return report;
	} catch (error) {
		if (active?.status === "RUNNING") active.status = "BLOCKED";
		report.status = "BLOCKED";
		report.errorClass = error?.constructor?.name ?? "Unknown";
		report.errorDigest = hash(String(error?.message ?? error));
		return report;
	} finally {
		clearTimeout(deadlineTimer);
		dispatchChannel.unsubscribe(dispatchListener);
		controller.abort();
		await Promise.all(pendingUsage);
		report.ended = Date.now(); save();
		console.log(JSON.stringify({ status: report.status, chains: report.chains.length, admittedRequests: report.requests.length, modelDispatches: report.networkModelDispatches, report: reportPath }));
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [baseline, candidate, output, mode, priorReport] = process.argv.slice(2);
	assert(baseline && candidate && output && ["--preflight", "--live"].includes(mode), "Usage: live.mjs <baseline-product> <candidate-product> <private-output-dir> --preflight|--live");
	const result = await run(baseline, candidate, output, mode === "--live", priorReport);
	if (["BLOCKED", "REGRESSION"].includes(result.status)) process.exitCode = 1;
}
