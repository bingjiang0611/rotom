// Shared setup for the local failure-set regression tests: synthetic sessions only.
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after } from "node:test";
import { fixtureSession } from "../../extensions/observability/eval-fixtures.mjs";
import { readAnnotations, writeAnnotation } from "../../extensions/observability/eval/annotations.mjs";
import { readReplayCases, sessionSha256, writeReplayCase } from "../../extensions/observability/eval/replay.mjs";
import { loadSession } from "../../extensions/observability/eval/session-data.mjs";
import { REPLAY_JUDGE_PROMPT_VERSION } from "../../extensions/observability/eval/replay.mjs";
import { buildRegressionSet, sessionIndex, sourceReader } from "../scripts/regression-set.mjs";

const scratch = [];
after(async () => { for (const path of scratch) await rm(path, { recursive: true, force: true }); });

export async function workspace() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "rotom-regression-test-")));
	scratch.push(root);
	const sessions = join(root, "sessions"), directory = join(root, "evals");
	await mkdir(join(sessions, "project-a"), { recursive: true, mode: 0o700 });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return { root, sessions, directory };
}

/** One synthetic session pinned at its last assistant message. */
export async function point({ sessions, directory, id = "synthetic-one", note = "合成失败：没有先查再结论。", failSet = true, verdict = "fail" }) {
	const path = await fixtureSession(join(sessions, "project-a"), id);
	const loaded = await loadSession(path, { badJson: 0, lineTooLong: 0 }, new Set());
	const pinned = loaded.branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
	await writeAnnotation(directory, { sessionId: id, verdict, note, failSet: verdict === "fail" && failSet }, { atEntryId: pinned.id, atEntryCount: loaded.branch.length });
	const saved = await writeReplayCase(directory, { sessionId: id, cutEntryId: pinned.id, expected: "先查询再下结论，并说明尚未验证的部分。", check: { mode: "model" } }, sessionSha256(await readFile(path, "utf8")));
	return { ...saved, path, pinnedId: pinned.id };
}

export async function frozenSet({ sessions, directory, name = "failures", selector = "all" }) {
	const index = await sessionIndex(sessions);
	const set = await buildRegressionSet({ directory, name, selector: { kind: selector }, cases: await readReplayCases(directory), labels: await readAnnotations(directory), resolveSource: sourceReader(index), indexComplete: index.complete });
	return { set, index };
}

export const row = (arm, verdict, extra = {}) => ({ arm, verdict, checkMode: "model", judgePromptVersion: REPLAY_JUDGE_PROMPT_VERSION, usage: null, ...extra });
