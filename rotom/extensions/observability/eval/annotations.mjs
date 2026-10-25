import { constants } from "node:fs";
import { chmod, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parseLabel, privateWrite, statIfPresent } from "./session-data.mjs";
import { RULE_IDS } from "./trace-assertions.mjs";

export const DEFAULT_EVAL_DIRECTORY = join(homedir(), ".rotom/evals");
export const ANNOTATION_SCHEMA = "rotom-eval-annotation/v1";
export function validSessionId(id) {
	return typeof id === "string" && id.length > 0 && id !== "." && Buffer.byteLength(id, "utf8") <= 200 && !/[/\\\u0000-\u001f\u007f]/u.test(id) && !id.includes("..");
}

// All components, not just the leaf: annotations must never redirect through
// a symlinked private directory. Missing descendants are fine on first use.
export async function assertPrivatePath(path) {
	const absolute = resolve(path);
	let current = sep;
	for (const component of absolute.split(sep).filter(Boolean)) {
		current = join(current, component);
		const info = await statIfPresent(current);
		if (!info) break;
		if (info.isSymbolicLink()) throw new Error("Symlink in private storage");
	}
}

async function readPrivate(path, maximum) {
	await assertPrivatePath(path);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > maximum) throw new Error("Invalid private file");
		// Read only the statted byte boundary; concurrent append must not turn a
		// bounded private read into an unbounded readFile allocation.
		const buffer = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (!bytesRead) throw new Error("Private file changed during read");
			offset += bytesRead;
		}
		return buffer.toString("utf8");
	} finally { await handle.close(); }
}

export function annotationInput(input) {
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["sessionId", "verdict", "note", "failSet"].includes(key)) ||
		!validSessionId(input.sessionId) || !["pass", "fail"].includes(input.verdict) || typeof input.note !== "string" || typeof input.failSet !== "boolean" || (input.failSet && input.verdict !== "fail")) throw new Error("Invalid annotation");
	return { sessionId: input.sessionId, verdict: input.verdict, note: Array.from(input.note).slice(0, 500).join(""), failSet: input.failSet };
}

export async function readAnnotations(directory = DEFAULT_EVAL_DIRECTORY) {
	const folder = join(directory, "annotations");
	await assertPrivatePath(folder);
	if (!(await statIfPresent(folder))) return new Map();
	const result = new Map();
	for (const name of await readdir(folder)) {
		if (!name.endsWith(".json")) continue;
		const row = JSON.parse(await readPrivate(join(folder, name), 8192));
		const input = annotationInput({ sessionId: row.sessionId, verdict: row.verdict, note: row.note, failSet: row.failSet });
		if (name !== `${input.sessionId}.json` || row.schema !== ANNOTATION_SCHEMA || row.source !== "dashboard" || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error("Invalid stored annotation");
		result.set(input.sessionId, { ...row, ...input });
	}
	return result;
}

export async function writeAnnotation(directory, input) {
	const value = annotationInput(input);
	const folder = join(directory, "annotations");
	await assertPrivatePath(folder);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await assertPrivatePath(folder);
	await chmod(directory, 0o700);
	await chmod(folder, 0o700);
	const target = join(folder, `${value.sessionId}.json`);
	await assertPrivatePath(target);
	const row = { schema: ANNOTATION_SCHEMA, ...value, updatedAt: new Date().toISOString(), source: "dashboard" };
	await privateWrite(target, JSON.stringify(row) + "\n");
	return row;
}

/** The one label merge used by CLI and dashboard. Never writes either source. */
export async function mergedLabels({ out = join(DEFAULT_EVAL_DIRECTORY, "cards") } = {}) {
	await assertPrivatePath(out);
	const rows = new Map();
	const names = await statIfPresent(out) ? await readdir(out) : [];
	// Preserve export-only agreement clients. Live cards, when present, are the
	// source of truth; an old export must not resurrect a cleared card label.
	const exported = join(dirname(out), "labels.jsonl");
	if (!names.some((name) => name.endsWith(".md")) && await statIfPresent(exported)) {
		let records;
		try { records = (await readPrivate(exported, 16 * 1024 * 1024)).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)); }
		catch { throw new Error("Invalid labels input"); }
		for (const row of records) {
			if (!validSessionId(row.sessionId) || rows.has(row.sessionId)) throw new Error("Invalid labels input");
			rows.set(row.sessionId, { ...row, failSet: row.failSet === true });
		}
	}
	if (names.length) for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const cardPath = join(out, name);
		const card = await readPrivate(cardPath, 16 * 1024 * 1024);
		const label = parseLabel(card);
		if (!label.verdict) continue;
		const session = /^---\r?\nsession: (.+)\r?\n/u.exec(card);
		const sessionId = session ? JSON.parse(session[1]) : undefined;
		if (!validSessionId(sessionId) || name !== `${sessionId}.md`) throw new Error("Card identity mismatch");
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(card)?.[1];
		const field = /^findings: (.+)$/m.exec(frontmatter ?? "");
		const stored = field ? JSON.parse(field[1]) : undefined;
		const findings = Object.fromEntries(RULE_IDS.map((rule) => {
			const status = field ? stored?.[rule] : "unknown";
			if (!["hit", "clear", "unknown"].includes(status)) throw new Error("Invalid findings metadata");
			return [rule, status];
		}));
		rows.set(sessionId, { sessionId, verdict: label.verdict, categories: label.categories, note: label.note, cardPath, labeledAt: new Date().toISOString(), findings, failSet: false });
	}
	let conflicts = 0;
	for (const [id, annotation] of await readAnnotations(dirname(out))) {
		const card = rows.get(id);
		if (card && (card.verdict !== annotation.verdict || card.note !== annotation.note || card.failSet !== annotation.failSet)) conflicts++;
		rows.set(id, { ...(card ?? { sessionId: id, categories: [], findings: Object.fromEntries(RULE_IDS.map((rule) => [rule, "unknown"])) }), verdict: annotation.verdict, note: annotation.note, failSet: annotation.failSet, labeledAt: annotation.updatedAt, source: "dashboard" });
	}
	return { rows: [...rows.values()], conflicts };
}
