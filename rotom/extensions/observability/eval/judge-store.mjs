import { chmod, link, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertPrivatePath, readPrivate, validSessionId } from "./annotations.mjs";
import { privateWrite, statIfPresent } from "./session-data.mjs";

export const JUDGMENT_SCHEMA = "rotom-eval-judgment/v1";
const statuses = ["ok", "invalid_output", "failed", "timeout", "cancelled"];
export async function latestJudgments(directory, ids) {
	const root = join(directory, "judgments");
	await assertPrivatePath(root);
	if (!(await statIfPresent(root))) return new Map();
	const result = new Map();
	for (const id of ids ?? await readdir(root)) {
		if (!validSessionId(id)) throw new Error("Invalid judgment identity");
		const folder = join(root, id);
		await assertPrivatePath(folder);
		if (!(await statIfPresent(folder))) continue;
		const names = (await readdir(folder)).filter((name) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/u.test(name)).sort();
		if (!names.length) continue;
		const row = JSON.parse(await readPrivate(join(folder, names.at(-1)), 128 * 1024));
		if (row.schema !== JUDGMENT_SCHEMA || row.sessionId !== id || !statuses.includes(row.status)) throw new Error("Invalid judgment record");
		// Diagnostic model output stays on disk, never in the list/detail API.
		const { rawOutput, ...latest } = row;
		result.set(id, { latest, historyCount: names.length });
	}
	return result;
}
export async function writeJudgment(directory, value) {
	if (!validSessionId(value.sessionId) || !statuses.includes(value.status)) throw new Error("Invalid judgment record");
	const root = join(directory, "judgments"), folder = join(root, value.sessionId);
	await assertPrivatePath(folder);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await assertPrivatePath(folder);
	for (const path of [directory, root, folder]) await chmod(path, 0o700);
	const timestamp = new Date().toISOString();
	const target = join(folder, timestamp.replaceAll(":", "-") + ".json");
	const temporary = join(folder, "." + randomUUID() + ".tmp");
	const record = { schema: JUDGMENT_SCHEMA, ...value, createdAt: timestamp };
	await privateWrite(temporary, JSON.stringify(record) + "\n");
	try {
		await assertPrivatePath(target);
		// link is an atomic, no-replace publication. Never overwrite history,
		// including a coincident timestamp produced by another dashboard.
		await link(temporary, target);
	} finally { await unlink(temporary); }
	return record;
}
export function judgeAgreement(labels, judgments) {
	const counts = { tp: 0, fp: 0, fn: 0, tn: 0, n: 0 };
	for (const label of labels) {
		const judgment = judgments.get(label.sessionId)?.latest;
		const verdict = judgment?.result?.suggestedVerdict;
		if (judgment?.status !== "ok" || !["pass", "fail"].includes(verdict) || !["pass", "fail"].includes(label.verdict)) continue;
		counts.n++;
		counts[label.verdict === "fail" ? verdict === "fail" ? "tp" : "fn" : verdict === "fail" ? "fp" : "tn"]++;
	}
	return counts;
}
