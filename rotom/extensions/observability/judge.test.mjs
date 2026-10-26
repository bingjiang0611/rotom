import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureSession } from "./eval-fixtures.mjs";
import { fakeJudgeLauncher } from "./judge-fixtures.mjs";
import { createEvalService } from "./eval/service.mjs";
import { createJudgeService, JUDGE_BASE_ARGS, parseJudgeEvents, parseModelCatalog } from "./eval/judge.mjs";
import { buildJudgeInput, JUDGE_MAX_INPUT_CHARS, validateJudgment } from "./eval/judge-prompt.mjs";
import { latestJudgments, judgeAgreement, writeJudgment } from "./eval/judge-store.mjs";
import { redactSecrets } from "./eval/redaction.mjs";
import { startTraceDashboard } from "./dashboard.mjs";
import { productRuntimeArgs } from "../../runtime/launch-runtime.mjs";
import { COPY } from "./eval/copy.mjs";

async function fixture(t, options = {}) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "rotom-judge-test-")));
	const root = join(dir, "sessions"), directory = join(dir, "evals");
	await fixtureSession(root, "synthetic-active", { active: true, large: true });
	const fake = await fakeJudgeLauncher(dir);
	const evalService = createEvalService(root, directory);
	const judge = createJudgeService({ evalService, directory, launcher: fake.launcher, timeoutMs: 5000, ...options });
	t.after(async () => { try { await judge.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
	return { dir, root, directory, fake, evalService, judge };
}
async function done(judge, id) {
	const deadline = Date.now() + 12000;
	while (judge.status(id).status === "running") {
		if (Date.now() > deadline) throw new Error("Fake judge failed to settle");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return judge.status(id);
}
async function calls(fake) { return (await readFile(fake.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
const input = { sessionId: "synthetic-active", model: "fake/model" };

test("bounded independent judge input has numbered events, explicit truncation and strict output validation", async (t) => {
	const { evalService } = await fixture(t);
	const { loaded } = await evalService.snapshot(input.sessionId);
	const built = buildJudgeInput({ ...loaded, annotation: { note: "PRIVATE_LABEL_SENTINEL" } });
	assert.ok(built.inputChars <= JUDGE_MAX_INPUT_CHARS); assert.equal(built.truncated, true);
	assert.ok(built.prompt.includes("[已截断")); assert.ok(built.prompt.includes('"event":3')); assert.ok(!built.prompt.includes("PRIVATE_LABEL_SENTINEL"));
	assert.match(built.inputDigest, /^[a-f0-9]{64}$/);
	assert.equal(built.eventIds.length, 54, "retain all events, including every late user message");
	assert.ok(built.prompt.includes('"event":54'));
	assert.throws(() => buildJudgeInput(loaded, 100), /judge_input_too_large/);
	loaded.branch.push({ type: "message", id: "empty-user", message: { role: "user", content: [] } });
	assert.equal(buildJudgeInput(loaded).eventIds.length, 55, "empty-text user events are not discarded");
	const valid = { suggestedVerdict: "unsure", confidence: 0.5, summary: "缺少证据", firstProblem: null, categories: [], evidence: [], suggestions: [] };
	assert.equal(validateJudgment(valid, [1]), valid);
	for (const change of [{ confidence: 2 }, { confidence: "0.1" }, { summary: "字".repeat(301) }, { firstProblem: { event: 2, description: "越界" } }, { categories: ["other", "other"] }, { evidence: [{ event: 1, quote: "字".repeat(201) }] }, { extra: 1 }]) assert.throws(() => validateJudgment({ ...valid, ...change }, [1]));
	assert.equal(parseJudgeEvents('{"type":"agent_end"}\n', [1]).status, "failed");
});

test("long histories fold only unprotected ok runs and reject citations into folded ranges", () => {
	const branch = [], expected = [];
	function message(role, text) {
		branch.push({ type: "message", message: { role, content: [{ type: "text", text }] } });
		expected.push({ kind: role });
	}
	message("user", "合成初始要求");
	for (let index = 0; index < 1300; index++) {
		if (index === 400) message("user", "合成后续约束");
		if (index === 700) message("assistant", "合成进度说明");
		const name = index % 2 ? "read" : "bash", id = "call-" + index;
		branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { index } }] } });
		if (index !== 900) branch.push({ type: "message", message: { role: "toolResult", toolCallId: id, isError: index === 600, content: [{ type: "text", text: "合成结果" }] } });
		expected.push({ kind: "tool", name, outcome: index === 900 ? "unknown" : index === 600 ? "tool_error" : "ok" });
	}
	message("assistant", "合成最终回复");
	const built = buildJudgeInput({ branch, trace: { tools: new Map() } });
	const data = JSON.parse(built.prompt.split("会话数据（不含人工标注）：\n")[1]);
	assert.ok(built.inputChars <= JUDGE_MAX_INPUT_CHARS); assert.equal(built.truncated, true);
	assert.ok(data.events.length < 70);
	const protectedIndices = new Set();
	for (let index = 0; index < expected.length; index++) {
		if (expected[index].kind !== "tool" || index < 20 || index >= expected.length - 20) protectedIndices.add(index);
		if (expected[index].kind === "tool" && expected[index].outcome !== "ok") {
			for (let near = index - 2; near <= index + 2; near++) protectedIndices.add(near);
		}
	}
	const covered = [], folded = [];
	for (const event of data.events) {
		if (event.kind !== "tool_run") { covered.push(event.event); continue; }
		const [first, last] = event.events.split("-").map(Number), tools = {};
		assert.equal(event.count, last - first + 1);
		for (let number = first; number <= last; number++) {
			assert.ok(!protectedIndices.has(number - 1));
			assert.equal(expected[number - 1].outcome, "ok");
			const name = expected[number - 1].name; tools[name] = (tools[name] ?? 0) + 1;
			covered.push(number); folded.push(number);
		}
		assert.deepEqual(event.tools, tools);
	}
	assert.deepEqual(covered, expected.map((_, index) => index + 1));
	assert.deepEqual(built.eventIds, data.events.filter((event) => event.kind !== "tool_run").map((event) => event.event));
	for (const index of protectedIndices) assert.ok(built.eventIds.includes(index + 1));
	const valid = { suggestedVerdict: "fail", confidence: 0.7, summary: "合成判断", firstProblem: null, categories: [], evidence: [], suggestions: [] };
	for (const event of folded) {
		assert.throws(() => validateJudgment({ ...valid, firstProblem: { event, description: "不能引用已折叠事件" } }, built.eventIds));
		assert.throws(() => validateJudgment({ ...valid, evidence: [{ event, quote: "不能引用已折叠事件" }] }, built.eventIds));
	}
	assert.equal(validateJudgment({ ...valid, evidence: [{ event: 1, quote: "合成初始要求" }] }, built.eventIds).evidence[0].event, 1);
	const irreducible = { branch: Array.from({ length: 3000 }, () => ({ type: "message", message: { role: "user", content: "合成要求" } })), trace: { tools: new Map() } };
	assert.throws(() => buildJudgeInput(irreducible), /judge_input_too_large/);
});

test("model catalog diagnostics distinguish protocol and process failures without exposing stderr", () => {
	const valid = { models: [{ id: "fake/model" }], defaultModel: "fake/model" };
	const output = { code: 0, terminal: { outcome: "exited", confirmed: true }, stdout: JSON.stringify(valid), stderr: "" };
	assert.deepEqual(parseModelCatalog(output), valid);
	assert.deepEqual(parseModelCatalog({ ...output, stdout: '{"models":[],"defaultModel":null}' }), { models: [], defaultModel: null });
	const cases = [
		[{ terminal: { outcome: "timeout", confirmed: true } }, "models_timeout"],
		[{ terminal: { outcome: "spawn-error", confirmed: true } }, "launcher_unavailable"],
		[{ terminal: { outcome: "unavailable", confirmed: false } }, "termination_unknown"],
		[{ code: 1, stderr: "rotom: [runtime_validation_failed] synthetic private path" }, "models_identity_failed"],
		[{ code: 7 }, "models_exit_failed"],
		[{ stdout: "", stderr: JSON.stringify(valid) }, "models_stdout_empty"],
		[{ stdout: "not json" }, "models_invalid_json"],
		[{ stdout: '{"models":[null],"defaultModel":null}' }, "models_invalid_catalog"],
		[{ stdout: JSON.stringify({ ...valid, models: [...valid.models, ...valid.models] }) }, "models_duplicate_ids"],
		[{ stdout: JSON.stringify({ ...valid, defaultModel: "missing/model" }) }, "models_default_missing"],
	];
	for (const [change, code] of cases) {
		assert.throws(() => parseModelCatalog({ ...output, ...change }), (error) => error.status === 503 && error.code === code && error.message === code);
		assert.ok(COPY.errors[code]);
	}
	assert.equal(COPY.modelCheckCommand, "rotom/bin/rotom-launcher " + [...JUDGE_BASE_ARGS, "--list-models"].join(" "));
});

test("stderr-only catalog is logged locally, never merged into stdout or returned by the API", async (t) => {
	const { root, directory, fake } = await fixture(t);
	const diagnostics = [];
	t.mock.method(console, "error", (text) => diagnostics.push(text));
	await writeFile(fake.control, JSON.stringify({ modelsStderr: true }));
	const dashboard = await startTraceDashboard({ root, evalDirectory: directory, judge: { launcher: fake.launcher } });
	t.after(() => dashboard.close());
	const response = await fetch(dashboard.baseUrl + "/api/eval/models", { headers: { Authorization: "Bearer " + dashboard.token } });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "models_stdout_empty" });
	assert.equal(diagnostics.length, 1);
	assert.ok(diagnostics[0].includes('"models"'));
	assert.equal((await calls(fake)).length, 1);
});

test("missing launcher has an explicit actionable failure", async (t) => {
	const { dir, evalService, directory } = await fixture(t);
	const judge = createJudgeService({ evalService, directory, launcher: join(dir, "missing-launcher") });
	await assert.rejects(judge.models(), { code: "launcher_unavailable" });
	await judge.close();
});

test("failed model discovery is not cached or automatically retried; a successful retry is shared", async (t) => {
	const { judge, fake } = await fixture(t);
	await writeFile(fake.control, JSON.stringify({ modelsFail: true }));
	const failures = await Promise.allSettled([judge.models(), judge.models()]);
	assert.ok(failures.every((result) => result.status === "rejected"));
	assert.equal((await calls(fake)).length, 1);
	await writeFile(fake.control, JSON.stringify({ mode: "ok" }));
	assert.deepEqual(await Promise.all([judge.models(), judge.models()]), [
		{ models: [{ id: "fake/model" }], defaultModel: "fake/model" }, { models: [{ id: "fake/model" }], defaultModel: "fake/model" },
	]);
	await judge.models();
	const logs = await calls(fake);
	assert.equal(logs.length, 2);
	assert.ok(logs.every((row) => row.args.includes("--list-models")), "retry never starts inference");
});

test("fake launcher proves exact argv, private empty cwd, stdin, model caching, confirmation, permissions, and no annotation write", async (t) => {
	const { judge, fake, directory } = await fixture(t);
	process.env.ROTOM_FAKE_SECRET = "synthetic-secret"; t.after(() => { delete process.env.ROTOM_FAKE_SECRET; });
	await Promise.all([judge.models(), judge.models()]);
	assert.equal((await calls(fake)).length, 1);
	await assert.rejects(judge.prepare({ ...input, model: "not/in-list" }), /invalid_model/);
	assert.throws(() => judge.start({ confirmationId: "invented" }), /confirmation_expired/);
	const prepared = await judge.prepare(input);
	assert.equal((await calls(fake)).length, 1, "preview never runs inference");
	const job = judge.start({ confirmationId: prepared.confirmationId });
	assert.throws(() => judge.start({ confirmationId: prepared.confirmationId }), /judge_busy/);
	assert.equal((await done(judge, job.runId)).status, "ok");
	assert.throws(() => judge.start({ confirmationId: prepared.confirmationId }), /confirmation_expired/);
	const logs = await calls(fake); assert.equal(logs.length, 2);
	assert.deepEqual(logs[0].args, [...JUDGE_BASE_ARGS, "--list-models"]);
	assert.deepEqual(logs[1].args, [...JUDGE_BASE_ARGS, "--model", "fake/model"]);
	assert.deepEqual(logs[1].files, []); assert.equal(logs[1].mode, 0o700); assert.equal(logs[1].node, process.execPath); assert.equal(logs[1].secret, false);
	assert.ok(logs[1].body.includes("如果这是交给同事的活")); assert.ok(logs[1].body.length > 100);
	await assert.rejects(stat(logs[1].cwd), { code: "ENOENT" });
	await assert.rejects(stat(join(directory, "annotations")), { code: "ENOENT" });
	const folder = join(directory, "judgments", input.sessionId), names = await readdir(folder);
	assert.equal(names.length, 1); assert.equal((await stat(folder)).mode & 0o777, 0o700); assert.equal((await stat(join(folder, names[0]))).mode & 0o777, 0o600);
	const record = (await latestJudgments(directory)).get(input.sessionId).latest;
	assert.equal(record.schema, "rotom-eval-judgment/v1"); assert.equal(record.atEntryId, "entry-53"); assert.equal(record.result.suggestedVerdict, "fail");
	assert.equal(record.usage.input, 100); assert.equal(record.usage.costSource, "pi_estimate"); assert.equal(record.usage.billing, "unknown");
});

test("failure, invalid JSON, timeout, cancellation and output limits are terminal without retry", async (t) => {
	const { judge, fake, directory } = await fixture(t);
	await judge.models();
	const cases = [["fail", "failed"], ["invalid", "invalid_output"], ["hang", "timeout"], ["hang", "cancelled"], ["oversized", "failed"], ["truncated", "failed"]];
	for (const [mode, expected] of cases) {
		await writeFile(fake.control, JSON.stringify({ mode }));
		const prepared = await judge.prepare(input), job = judge.start({ confirmationId: prepared.confirmationId });
		if (expected === "cancelled") {
			const deadline = Date.now() + 8000;
			while ((await calls(fake)).length < cases.findIndex((row) => row[1] === "cancelled") + 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal((await calls(fake)).length, cases.findIndex((row) => row[1] === "cancelled") + 2, "wait for the owned fake process before cancelling");
			judge.cancel({ runId: job.runId });
		}
		const terminal = await done(judge, job.runId);
		assert.equal(terminal.status, expected); assert.equal(terminal.processConfirmed, true);
		const all = await calls(fake), last = all.at(-1);
		assert.throws(() => process.kill(last.pid, 0), { code: "ESRCH" });
		const stored = (await latestJudgments(directory)).get(input.sessionId);
		assert.equal(stored.latest.status, expected);
		if (expected === "invalid_output") {
			const names = (await readdir(join(directory, "judgments", input.sessionId))).sort();
			const row = JSON.parse(await readFile(join(directory, "judgments", input.sessionId, names.at(-1)), "utf8"));
			assert.ok(row.rawOutput.includes("不是 JSON")); assert.equal(stored.latest.rawOutput, undefined);
		}
	}
	assert.equal((await calls(fake)).length, 7, "one discovery plus exactly one invocation per explicit confirmation");
	assert.equal((await latestJudgments(directory)).get(input.sessionId).historyCount, 6);
});

test("credential shapes are redacted before truncation and recorded by type", () => {
	// Fixtures are assembled at runtime so the public-tree credential scan keeps
	// flagging real-looking literals anywhere in the repository: a prefix literal
	// is never long enough to match on its own, the repeating body is generated.
	const secret = (parts) => parts.join("");
	const credential = secret(["sk-ant-", "A".repeat(24)]);
	const secrets = [
		["anthropic-key", secret(["sk-ant-", "A".repeat(24)])],
		["openai-key", secret(["sk-proj-", "B".repeat(24)])],
		["github-token", secret(["ghp_", "C".repeat(32)])],
		["aws-access-key", secret(["AKIA", "D".repeat(16)])],
		["slack-token", secret(["xoxb-", "123456789012-abcdefghijkl"])],
		["jwt", secret(["eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"])],
		["bearer-token", secret(["Bearer ", "E".repeat(20)])],
		["assigned-secret", secret(["API_KEY=", "F".repeat(16)])],
		["private-key", secret(["-----BEGIN RSA PRIVATE KEY-----\n", "MIIEow\n", "-----END RSA PRIVATE KEY-----"])],
	];
	for (const [type, value] of secrets) {
		const result = redactSecrets(`before ${value} after`);
		assert.ok(!result.text.includes(value.split(" ").at(-1).slice(0, 12)) || result.text.includes("[已脱敏:"), type);
		assert.ok(result.redactions.some((entry) => entry.type === type), `${type} was not recorded`);
		assert.ok(result.text.includes(`[已脱敏:${type}]`), type);
	}
	const cleanText = "token budget 4096; commit 3f786850e387550fdab836ed7e6dc881de23001b; id 123e4567-e89b-12d3-a456-426614174000; the word secret appears alone";
	const clean = redactSecrets(cleanText);
	assert.deepEqual(clean.redactions, []);
	assert.equal(clean.text, cleanText);
	// Review round 1: these ordinary coding strings were being rewritten, which
	// corrupts the paths and code the judge needs to read.
	const packageName = ["sk-learn-", "preprocessing", "-pipeline-v2"].join("");
	const untouched = [
		"pwd: /srv/app/rotom-eval",
		"PWD=/srv/app/rotom-eval",
		"secret = os.environ['X']",
		"password: ********",
		"token=2048tokens",
		packageName,
		"token: $GITHUB_TOKEN",
		"api_key = process.env.API_KEY",
	];
	for (const sample of untouched) {
		const result = redactSecrets(sample);
		assert.deepEqual(result.redactions, [], `false positive on ${sample}`);
		assert.equal(result.text, sample, `text rewritten for ${sample}`);
	}
	// Review round 2: narrowing the rules for item 7 caused misses. A miss is
	// worse than a false positive here, so every shape below must still redact.
	// Bodies are generated so the repository never stores a key-shaped literal.
	const lowerHex = "a".repeat(32), openaiStyle = ["sk-proj-", "abc123def456", "ghi789jkl012", "mno345"].join("");
	const mustRedact = [
		["openai-key", `DEEPSEEK_API_KEY=sk-${lowerHex}`],
		["openai-key", `x-key: sk-${lowerHex}`],
		["openai-key", `export OPENAI_API_KEY="${openaiStyle}"`],
		["assigned-secret", `OPENAI_API_KEY=${"b".repeat(24)}`],
		["assigned-secret", `GITHUB_TOKEN=${"c".repeat(24)}`],
		["assigned-secret", `AWS_SECRET_ACCESS_KEY=${"d".repeat(24)}`],
		["assigned-secret", `x-api-key: ${"e".repeat(24)}`],
		// Numeric passwords and PINs are common; a bare number is not a reference.
		["assigned-secret", "password: 20240101"],
		["assigned-secret", "password=83920174"],
	];
	for (const [type, sample] of mustRedact) {
		const result = redactSecrets(sample);
		assert.ok(result.redactions.some((entry) => entry.type === type), `${sample} was not recorded as ${type}`);
		assert.ok(result.text.includes("[已脱敏:"), `${sample} was not redacted`);
		// Reported counts must match the markers the prompt will contain.
		for (const { type: reported, count } of result.redactions) {
			assert.equal(result.text.split(`[已脱敏:${reported}]`).length - 1, count, `${sample} count mismatch for ${reported}`);
		}
	}
	// Token budgets are configuration, not credentials.
	for (const sample of ["MAX_TOKENS=200000", "max_tokens = 4096", "tokens=512"]) {
		assert.deepEqual(redactSecrets(sample).redactions, [], `token budget was redacted: ${sample}`);
	}
	// Control: the same shapes still redact when the value is a literal secret,
	// assembled at runtime so the repository holds no key-shaped literal.
	const literalKey = ["sk-live-", "ABCDEF", "12345678"].join("");
	assert.ok(redactSecrets(`api_key = ${literalKey}`).redactions.length > 0);
	const literalPassword = ["hunter2", "hunter2"].join("");
	assert.ok(redactSecrets(`password: ${literalPassword}`).redactions.some((entry) => entry.type === "assigned-secret"));
	const truncatedField = redactSecrets(`x`.repeat(50) + " " + credential + " " + "y".repeat(50));
	assert.ok(!truncatedField.text.includes(credential));
	assert.ok(truncatedField.text.includes("[已脱敏:anthropic-key]"));
});

test("a real secret in the session is redacted before it reaches the prompt", async (t) => {
	const { evalService, fake, directory, root } = await fixture(t);
	// Two occurrences of the same credential: one in the request, one in the tool
	// arguments. The fixture writes them into the session so absence in the prompt
	// is evidence rather than a property of an empty fixture.
	const secret = ["sk-ant-", "A".repeat(24)].join("");
	await fixtureSession(root, "synthetic-secret", { secrets: [secret, secret] });
	const judge = createJudgeService({ evalService, directory, launcher: fake.launcher, timeoutMs: 5000 });
	await judge.models();
	const { loaded } = await evalService.snapshot("synthetic-secret");
	assert.ok(JSON.stringify(loaded.branch).includes(secret), "fixture must actually contain the secret");
	const built = buildJudgeInput(loaded, 400_000);
	assert.equal(built.prompt.includes(secret), false, "raw secret reached the prompt");
	assert.ok(built.prompt.includes("[已脱敏:anthropic-key]"));
	const occurrences = built.prompt.split("[已脱敏:anthropic-key]").length - 1;
	const reported = built.redactions.find((entry) => entry.type === "anthropic-key")?.count ?? 0;
	// Item 1 of the review: counts must match the markers actually sent, not the
	// number of render() passes performed during the size search.
	assert.equal(reported, occurrences, "reported count must equal the markers in the prompt");
	const prepared = await judge.prepare({ sessionId: "synthetic-secret", model: "fake/model" });
	assert.deepEqual(prepared.redactions, built.redactions, "the dialog must show the same count");
	const job = judge.start({ confirmationId: prepared.confirmationId });
	await done(judge, job.runId);
	const stored = (await latestJudgments(directory)).get("synthetic-secret");
	assert.deepEqual(stored.latest.redactions, built.redactions, "the record must carry the same count");
	const sent = (await calls(fake)).at(-1).body;
	assert.equal(sent.includes(secret), false, "the launcher received the raw secret");
});

test("repeated renders do not multiply the reported redaction count", async (t) => {
	const { evalService, root } = await fixture(t);
	const secret = ["sk-ant-", "B".repeat(24)].join("");
	await fixtureSession(root, "synthetic-secret-wide", { secrets: [secret, secret], large: true });
	const { loaded } = await evalService.snapshot("synthetic-secret-wide");
	// A tight ceiling forces the binary search through many render() passes.
	const tight = buildJudgeInput(loaded, 120_000);
	const loose = buildJudgeInput(loaded, 400_000);
	assert.equal(tight.redactions.find((entry) => entry.type === "anthropic-key")?.count, loose.redactions.find((entry) => entry.type === "anthropic-key")?.count);
});

test("truncated model replies are reported as truncation, not format errors", async (t) => {
	const { judge, fake, directory } = await fixture(t);
	await judge.models();
	for (const mode of ["truncated", "oversized", "provider-error"]) {
		await writeFile(fake.control, JSON.stringify({ mode }));
		const prepared = await judge.prepare(input), job = judge.start({ confirmationId: prepared.confirmationId });
		const terminal = await done(judge, job.runId);
		assert.equal(terminal.status, "failed");
		const stored = (await latestJudgments(directory)).get(input.sessionId);
		assert.equal(stored.latest.failure, mode === "provider-error" ? "provider_error" : "output_truncated", mode);
	}
});

test("the input ceiling is a service option, not a hardcoded contract", async (t) => {
	const { evalService, fake } = await fixture(t);
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const directory = await mkdtemp(join(tmpdir(), "rotom-judge-limit-"));
	const narrow = createJudgeService({ evalService, directory, launcher: fake.launcher, maxInputChars: 10 });
	await assert.rejects(narrow.prepare({ sessionId: input.sessionId, model: "fake/model" }), /judge_input_too_large/);
	const wide = createJudgeService({ evalService, directory, launcher: fake.launcher, maxInputChars: 400_000 });
	const prepared = await wide.prepare({ sessionId: input.sessionId, model: "fake/model" });
	assert.ok(prepared.inputChars > 10);
});

test("judgment storage rejects symlinks, preserves history and agreement excludes unsure/failed", async (t) => {
	const { directory, dir } = await fixture(t);
	const outside = join(dir, "outside"); await mkdir(outside);
	await mkdir(directory); await symlink(outside, join(directory, "judgments"));
	await assert.rejects(writeJudgment(directory, { sessionId: "synthetic", status: "ok" }), /Symlink/);
	assert.deepEqual(await readdir(outside), []);
	const judgments = new Map([["a", { latest: { status: "ok", result: { suggestedVerdict: "fail" } } }], ["b", { latest: { status: "ok", result: { suggestedVerdict: "pass" } } }], ["c", { latest: { status: "ok", result: { suggestedVerdict: "unsure" } } }], ["d", { latest: { status: "failed", result: { suggestedVerdict: "fail" } } }]]);
	assert.deepEqual(judgeAgreement([{ sessionId: "a", verdict: "pass" }, { sessionId: "b", verdict: "fail" }, { sessionId: "c", verdict: "pass" }, { sessionId: "d", verdict: "fail" }], judgments), { tp: 0, fp: 1, fn: 1, tn: 0, n: 2 });
});

test("judge HTTP routes share auth, Origin, body bounds and are not launched by detail reads", async (t) => {
	const { root, directory, fake } = await fixture(t);
	const dashboard = await startTraceDashboard({ root, evalDirectory: directory, judge: { launcher: fake.launcher } }); t.after(() => dashboard.close());
	const headers = { Authorization: "Bearer " + dashboard.token, "Content-Type": "application/json" };
	for (const path of ["/api/eval/judge/prepare", "/api/eval/judge", "/api/eval/judge/cancel"]) {
		assert.equal((await fetch(dashboard.baseUrl + path, { method: "POST", body: "{}" })).status, 401);
		assert.equal((await fetch(dashboard.baseUrl + path, { method: "POST", headers: { ...headers, Origin: "https://evil.invalid" }, body: "{}" })).status, 403);
		assert.equal((await fetch(dashboard.baseUrl + path, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
		assert.equal((await fetch(dashboard.baseUrl + path, { method: "POST", headers, body: '"' + "x".repeat(5000) + '"' })).status, 413);
		const response = await fetch(dashboard.baseUrl + path, { headers }); assert.equal(response.status, 405); assert.equal(response.headers.get("allow"), "POST");
	}
	assert.equal((await fetch(dashboard.baseUrl + "/api/eval/session?id=synthetic-active", { headers })).status, 200);
	await assert.rejects(stat(fake.calls), { code: "ENOENT" });
});

test("closing the dashboard cancels and records its owned in-flight judge", async (t) => {
	const { root, directory, fake } = await fixture(t);
	await writeFile(fake.control, JSON.stringify({ mode: "hang" }));
	const dashboard = await startTraceDashboard({ root, evalDirectory: directory, judge: { launcher: fake.launcher } });
	t.after(() => dashboard.close());
	const headers = { Authorization: "Bearer " + dashboard.token, "Content-Type": "application/json" };
	const prepared = await (await fetch(dashboard.baseUrl + "/api/eval/judge/prepare", { method: "POST", headers, body: JSON.stringify(input) })).json();
	const response = await fetch(dashboard.baseUrl + "/api/eval/judge", { method: "POST", headers, body: JSON.stringify({ confirmationId: prepared.confirmationId }) });
	assert.equal(response.status, 202); await response.json();
	const deadline = Date.now() + 8000;
	while ((await calls(fake)).length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal((await calls(fake)).length, 2, "wait for the in-flight fake process before closing");
	const pid = (await calls(fake)).at(-1).pid;
	await dashboard.close();
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	assert.equal((await latestJudgments(directory)).get(input.sessionId).latest.status, "cancelled");
});

test("single-request product resources select only the identity-declared Qoder provider", () => {
	assert.deepEqual(productRuntimeArgs("/synthetic-product", true), ["--extension", "/synthetic-product/extensions/qoder/index.ts"]);
	assert.ok(productRuntimeArgs("/synthetic-product").length > 2);
});
