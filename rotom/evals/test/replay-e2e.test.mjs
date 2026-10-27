// Offline end-to-end replay test (L2): a real product runtime, a faux provider,
// a synthetic session, and a tool call that must never execute.
//
// Requires the product runtimes to be installed (CI installs them before this
// step). No network, no credentials: the faux provider answers.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureSession } from "../../extensions/observability/eval-fixtures.mjs";
import { loadSession } from "../../extensions/observability/eval/session-data.mjs";
import { assistantMessageOf, readReplayCases, replaySource, runReplayPlan, sessionSha256, writeReplayCase } from "../../extensions/observability/eval/replay.mjs";
import { createGenerator, createModelJudge } from "../scripts/session-replay.mjs";
import { loadReplayProduct, openReplaySession } from "../src/replay-session.ts";

const productDir = fileURLToPath(new URL("../../", import.meta.url));
const piExecutable = fileURLToPath(new URL("../../runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const piAiEntry = fileURLToPath(new URL("../../runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
const scratchRoots = [];
after(async () => { for (const path of scratchRoots) await rm(path, { recursive: true, force: true }); });

const available = await stat(piAiEntry).then(() => true, () => false);

async function space(prefix) {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	scratchRoots.push(root);
	const sessions = join(root, "sessions"), directory = join(root, "evals");
	await mkdir(sessions, { recursive: true, mode: 0o700 });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return { root, sessions, directory };
}

/** A faux provider that always answers with one bash tool call that touches a sentinel. */
async function fauxExtension(root, sentinel, replies = 1) {
	const path = join(root, "faux.mjs");
	await writeFile(path, `import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from ${JSON.stringify(piAiEntry)};
export default function(pi) {
	const faux = fauxProvider({ tokensPerSecond: 100000 });
	faux.setResponses([(_context, _options, state) => {
		if (state.callCount !== ${replies}) throw new Error("unexpected extra faux call: " + state.callCount);
		return fauxAssistantMessage([fauxText("先执行合成命令。"), fauxToolCall("bash", { command: "touch ${sentinel}" })]);
	}]);
	pi.registerProvider(faux.provider);
	console.log("replay-faux-ready");
}
`, { mode: 0o600 });
	return path;
}

test("a replay never executes a tool, twice, on two points, on both arms", { skip: available ? false : "product runtimes are not installed" }, async () => {
	const home = await space("rotom-replay-e2e-");
	const sessionId = "replay-e2e";
	await fixtureSession(home.sessions, sessionId);
	const sessionPath = join(home.sessions, `${sessionId}.jsonl`);
	const content = await readFile(sessionPath, "utf8");
	const sha = sessionSha256(content);
	const loaded = await loadSession(sessionPath, { badJson: 0, lineTooLong: 0 }, new Set());
	const points = loaded.branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").slice(0, 2).map((entry) => entry.id);
	assert.equal(points.length, 2, "fixture must contain two assistant messages");
	for (const cutEntryId of points) {
		await writeReplayCase(home.directory, { sessionId, cutEntryId, expected: "先查状态再执行", check: { mode: "rule", rule: "checks-before-claiming" } }, sha);
	}
	const cases = await readReplayCases(home.directory);
	assert.equal(cases.length, 2);

	// The sentinel lives outside the session workspace; if a tool ever ran it would
	// appear here. Nothing in this test may create it.
	const sentinel = join(home.root, "SENTINEL");
	const extension = await fauxExtension(home.root, sentinel);
	const digests = {};
	const generatorOf = async (excludedResourceKeys) => {
		const generator = await createGenerator({ productAgentDir: productDir, piExecutable, model: "faux/faux-1", extensions: [extension], excludedResourceKeys, cwd: await mkdtemp(join(tmpdir(), "rotom-replay-cwd-")) });
		return async (input) => { const result = await generator(input); digests[input.arm] = result.productDigest; return result; };
	};
	// The baseline arm declares one extension fewer, which is exactly the kind of
	// per-arm difference a real A/B sees. Pick a real resource so the exclusion bites.
	const full = await loadReplayProduct({ productAgentDir: productDir, piExecutable });
	const excluded = full.selection.selectedResources.find((resource) => resource.kind === "extension" || resource.kind === "skill");
	assert.ok(excluded, "the product must declare at least one resource");
	const candidate = await generatorOf(undefined);
	const baseline = await generatorOf([`${excluded.kind}:${excluded.id}`]);
	const results = await runReplayPlan({
		directory: home.directory, day: "2026-10-28", cases, arms: ["candidate", "baseline"], repeats: 2,
		sessionOf: async (item) => replaySource({ branch: loaded.branch, sessionContent: content, expectedSha256: sha, cutEntryId: item.cutEntryId }),
		generate: async ({ arm, entries }) => (arm === "baseline" ? baseline : candidate)({ arm, entries }),
	});
	assert.equal(results.length, 8);
	for (const row of results) {
		assert.equal(row.verdict, "pass", `${row.key} ${row.arm} #${row.repetition}: ${row.reason}`);
		assert.ok(row.reply?.text, "the assistant message must be recorded");
		assert.equal(row.reply.toolCalls.length, 1, "the intent to call a tool is recorded");
		assert.equal(row.reply.toolCalls[0].name, "bash");
		assert.match(String(row.reply.toolCalls[0].args.command), /touch/u);
	}
	await assert.rejects(() => stat(sentinel), /ENOENT/u, "a replay tool call must never execute");
	// Each arm loaded its own product surface, so the digests differ.
	assert.ok(digests.candidate && digests.baseline);
	assert.notEqual(digests.candidate, digests.baseline, "arms must load their own product surface");
});

test("the model judge path reaches the launcher and returns a verdict", { skip: available ? false : "product runtimes are not installed" }, async () => {
	const home = await space("rotom-replay-judge-");
	const judge = await createModelJudge({ model: "faux/faux-1" });
	// The faux provider is not registered for the judge child, so the honest result
	// is unknown with a reason; what matters is that the launcher itself ran.
	const verdict = await judge({ item: { expected: "先查状态" }, reply: assistantMessageOf({ content: [{ type: "text", text: "已完成。" }] }), entries: [] });
	assert.ok(["pass", "fail", "unknown"].includes(verdict.verdict));
	assert.equal(typeof verdict.reason, "string");
	assert.doesNotMatch(String(verdict.reason), /ENOEXEC|EACCES|bad interpreter/iu, "the launcher must be executed directly");
	void home;
});

test("a blocker that cannot load refuses to generate", { skip: available ? false : "product runtimes are not installed" }, async () => {
	const home = await space("rotom-replay-noblock-");
	const sessionId = "replay-blocker";
	await fixtureSession(home.sessions, sessionId);
	const sessionPath = join(home.sessions, `${sessionId}.jsonl`);
	const loaded = await loadSession(sessionPath, { badJson: 0, lineTooLong: 0 }, new Set());
	const cut = loaded.branch.find((entry) => entry.type === "message" && entry.message?.role === "assistant").id;
	const product = await loadReplayProduct({ productAgentDir: productDir, piExecutable });
	const scratch = await realpath(await mkdtemp(join(tmpdir(), "rotom-replay-noblock-")));
	scratchRoots.push(scratch);
	const extension = await fauxExtension(home.root, join(home.root, "UNUSED"));
	const entries = loaded.branch.slice(0, loaded.branch.findIndex((entry) => entry.id === cut));
	// Occupy the marker path with a directory: the blocker cannot record that it
	// loaded, so the session must not be handed out for generation.
	await mkdir(join(scratch, "blocker.marker"), { recursive: true });
	await assert.rejects(() => openReplaySession({ product, model: { provider: "faux", id: "faux-1" }, entries, scratch, extensions: [extension] }), /extensions failed to load|blocker/iu);
});
