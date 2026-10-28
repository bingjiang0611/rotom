// Failure-set regression, end to end (L2): the real CLI, a real product runtime, a
// faux provider, and a tool call that must never execute.
//
// This is the check that the frozen set, the confirmation gate, both arms, the
// original control and the exit code hold together. It needs the product runtimes
// installed; with them absent it skips instead of pretending to pass.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureSession } from "../../extensions/observability/eval-fixtures.mjs";
import { writeAnnotation } from "../../extensions/observability/eval/annotations.mjs";
import { loadSession } from "../../extensions/observability/eval/session-data.mjs";
import { readReplayCases, sessionSha256, writeReplayCase } from "../../extensions/observability/eval/replay.mjs";

const productDir = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = fileURLToPath(new URL("../scripts/eval-regression.mjs", import.meta.url));
const piAiEntry = fileURLToPath(new URL("../../runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
const scratch = [];
after(async () => { for (const path of scratch) await rm(path, { recursive: true, force: true }); });
const available = await stat(piAiEntry).then(() => true, () => false);

async function space(prefix) {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	scratch.push(root);
	const sessions = join(root, "sessions"), directory = join(root, "evals");
	await mkdir(join(sessions, "project-a"), { recursive: true, mode: 0o700 });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return { root, sessions, directory };
}

/** A faux answer; `toolCall` decides whether the arm queries before concluding. */
async function fauxExtension(root, { sentinel, toolCall }) {
	const path = join(root, toolCall ? "faux-query.mjs" : "faux-plan.mjs");
	const reply = toolCall
		? `fauxAssistantMessage([fauxText("先执行合成命令。"), fauxToolCall("bash", { command: "touch ${sentinel}" })])`
		: `fauxAssistantMessage([fauxText("已经处理完成。")])`;
	await writeFile(path, `import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from ${JSON.stringify(piAiEntry)};
export default function(pi) {
	const faux = fauxProvider({ tokensPerSecond: 100000 });
	faux.setResponses([(_context, _options, state) => {
		if (state.callCount !== 1) throw new Error("unexpected extra faux call: " + state.callCount);
		return ${reply};
	}]);
	pi.registerProvider(faux.provider);
}
`, { mode: 0o600 });
	return path;
}

async function cli(args) {
	const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ROTOM_QODER: "0", ROTOM_OBSERVABILITY: "0" }, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve) => child.once("close", resolve));
	return { code, stdout, stderr };
}

function lastJson(stdout) {
	const lines = stdout.trim().split("\n").filter(Boolean);
	return JSON.parse(lines.at(-1));
}

test("prepare freezes the reviewed failure set and run compares two arms without executing tools", { skip: available ? false : "product runtimes are not installed" }, async () => {
	const home = await space("rotom-regression-e2e-");
	const sessionId = "regression-e2e";
	const path = await fixtureSession(join(home.sessions, "project-a"), sessionId);
	const content = await readFile(path, "utf8");
	const loaded = await loadSession(path, { badJson: 0, lineTooLong: 0 }, new Set());
	// Pin the final assistant message: its prefix already contains a failed tool call,
	// so the point is about the next decision, not the tool's effect.
	const pinned = loaded.branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
	await writeAnnotation(home.directory, { sessionId, verdict: "fail", note: "合成失败：结论前没有查证。", failSet: true }, { atEntryId: pinned.id, atEntryCount: loaded.branch.length });
	await writeReplayCase(home.directory, { sessionId, cutEntryId: pinned.id, expected: "先查询再下结论。", check: { mode: "rule", rule: "checks-before-claiming" } }, sessionSha256(content));
	assert.equal((await readReplayCases(home.directory)).length, 1);

	const prepared = await cli(["prepare", "--name=failures", "--selector=failSet", `--directory=${home.directory}`, `--sessions=${home.sessions}`, "--json"]);
	assert.equal(prepared.code, 0, prepared.stderr);
	const preparedJson = lastJson(prepared.stdout);
	assert.equal(preparedJson.cases, 1);
	assert.equal(preparedJson.excluded.length, 0);
	const setFile = preparedJson.path;
	assert.equal((await stat(setFile)).mode & 0o777, 0o600);
	assert.equal((await stat(join(home.directory, "replay", "sets"))).mode & 0o777, 0o700);

	// The frozen set is the input, not the live store: deleting the reviewed point
	// after prepare must not change what the confirmed plan runs.
	const livePoint = (await readReplayCases(home.directory))[0];
	await rm(join(home.directory, "replay", "cases", `${livePoint.key}.json`));
	assert.equal((await readReplayCases(home.directory)).length, 0);

	// The faux answer queries before concluding, so both products pass and the run is
	// clean; the tool call must still never run.
	const sentinel = join(home.root, "SENTINEL");
	const passing = await cli([
		"run", "--set=failures", `--baseline=${productDir}`, `--candidate=${productDir}`, "--model=faux/faux-1",
		`--extension=${await fauxExtension(home.root, { sentinel, toolCall: true })}`,
		`--directory=${home.directory}`, `--sessions=${home.sessions}`, "--yes", "--json",
	]);
	assert.equal(passing.code, 0, passing.stderr);
	const report = lastJson(passing.stdout);
	assert.equal(report.counts.total, 1);
	assert.equal(report.points[0].comparison, "stable-pass");
	assert.equal(report.points[0].original, "fail", "the control must still see the reviewed failure");
	assert.equal(report.points[0].baseline, "pass");
	assert.equal(report.points[0].candidate, "pass");
	assert.deepEqual(Object.keys(report.arms).sort(), ["baseline", "candidate"]);
	assert.match(report.reportPath, /evals\/replay\/reports\/failures-/u);
	assert.equal((await stat(report.reportPath)).mode & 0o777, 0o600);
	assert.equal(report.points[0].check, "rule");
	// The frozen payload is deleted; only the report is left behind.
	assert.deepEqual((await readdir(join(home.directory, "replay", "reports"))).filter((name) => name.startsWith(".plan-")), []);
	// A tool that ran would leave this behind; blocking is the whole safety story.
	await assert.rejects(() => stat(sentinel), /ENOENT/u);

	// Without the query the step is still wrong, and "still failing" is exit 1, not 0.
	const failing = await cli([
		"run", "--set=failures", `--baseline=${productDir}`, `--candidate=${productDir}`, "--model=faux/faux-1",
		`--extension=${await fauxExtension(home.root, { sentinel, toolCall: false })}`,
		`--directory=${home.directory}`, `--sessions=${home.sessions}`, "--yes", "--json",
	]);
	assert.equal(failing.code, 1, failing.stderr);
	const failed = lastJson(failing.stdout);
	assert.equal(failed.points[0].comparison, "still-failing");
	assert.equal(failed.counts.stillFailing, 1);
	await assert.rejects(() => stat(sentinel), /ENOENT/u);
});
