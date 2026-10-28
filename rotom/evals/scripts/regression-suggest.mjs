// Suggestions for failure sessions that still have no replay point.
//
// Evidence only: this names the assistant step before a later user correction and
// says which fields a person still has to supply. It writes a private draft, never a
// replay point, and never calls a model.
import { join } from "node:path";
import { replayRoot, assistantMessageOf } from "../../extensions/observability/eval/replay.mjs";
import { redactSecrets } from "../../extensions/observability/eval/redaction.mjs";
import { assertPrivatePath } from "../../extensions/observability/eval/annotations.mjs";
import { privateWrite } from "../../extensions/observability/eval/session-data.mjs";
import { ensurePrivateFolder } from "./regression-set.mjs";

const SUGGESTION_EXCERPT_CHARS = 160;

/** Wording that usually marks a correction; only ever a hint for a person to confirm. */
const CORRECTION = /不对|错了|还是(?:不行|报错|失败|没|不|会)|没(?:看到|有(?:生效|改|完成|变化))|不能|不满意|重新做|再试|又(?:错|出现|失败|报)|仍未|依然|怎么还|没有解决|still (?:failing|broken|wrong)|not working|didn't work|doesn't work/iu;

export function suggestionsDir(directory) { return join(replayRoot(directory), "suggestions"); }

function message(error) { return error instanceof Error ? error.message : String(error); }

/**
 * Suggest a cut for a session that is marked fail but has no replay point.
 *
 * The suggestion is evidence, not a decision: it names the assistant message before a
 * later user correction, and says which fields a person still has to supply. Nothing
 * is written to the replay store and no model is called. The limit applies to the
 * sessions that actually need a point, so sessions that already have one cannot
 * exhaust it and hide the next gap.
 */
export async function suggestReplayPoints({ cases, labels, loadBranch, limit = 20 }) {
	const items = [], stale = [];
	for (const [sessionId, label] of labels) {
		if (label.verdict !== "fail") continue;
		const existing = cases.filter((item) => item.sessionId === sessionId);
		if (existing.length) { stale.push({ sessionId, key: existing[0].key }); continue; }
		if (items.length >= limit) continue;
		let branch;
		try { branch = await loadBranch(sessionId); }
		catch (error) { items.push({ sessionId, candidates: [], problem: `session_unreadable: ${message(error)}`, needs: ["channel"] }); continue; }
		const candidates = [];
		for (let index = 0; index < branch.length; index++) {
			const entry = branch[index];
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			const next = branch.slice(index + 1).find((row) => row?.type === "message" && row.message?.role === "user");
			const correction = next && typeof next.message.content !== "undefined" ? entryText(next) : "";
			if (!correction || !CORRECTION.test(correction)) continue;
			candidates.push({
				entryId: entry.id, isPinnedAssistant: true,
				evidence: redactSecrets(correction).text.slice(0, SUGGESTION_EXCERPT_CHARS),
				reply: redactSecrets(assistantMessageOf(entry.message).text).text.slice(0, SUGGESTION_EXCERPT_CHARS),
			});
		}
		// Latest correction first: the last wrong step is usually the one to fix.
		candidates.reverse();
		items.push({
			sessionId, candidates: candidates.slice(0, 2),
			problem: candidates.length ? null : "no_correction_evidence",
			needs: ["expected", "check", ...(candidates.length ? [] : ["entry"])],
			note: redactSecrets(label.note ?? "").text.slice(0, SUGGESTION_EXCERPT_CHARS),
		});
	}
	return { items, stale };
}

function entryText(entry) {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}


/** Suggestions are private drafts; the caller decides whether to accept one. */
export async function writeSuggestions(directory, items, now = () => new Date()) {
	const folder = suggestionsDir(directory);
	await ensurePrivateFolder(folder);
	const at = now().toISOString(), path = join(folder, `${at.replace(/[:.]/gu, "-")}.json`);
	await assertPrivatePath(path);
	await privateWrite(path, JSON.stringify({ schema: "rotom-replay-suggestions/v1", createdAt: at, items }) + "\n");
	return { path, at };
}
