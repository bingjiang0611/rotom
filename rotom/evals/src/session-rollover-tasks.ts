import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PiCodingAgentScenario } from "./pi-harness.ts";

/**
 * The two replay tasks and their grading.
 *
 * - `early-detail` asks again for a value recorded early, so an arm that lost it has to get it back.
 * - `no-hint` states a project rule in one turn and never repeats it, so an arm also has to know that
 *   an earlier constraint exists before it can retrieve it.
 *
 * Both use identical compaction settings and cut parameters; only the rollover switch differs.
 */
export const ROLLOVER_PRODUCT = resolve(import.meta.dirname, "../..");
/** Context window of the replay model is fixed by the harness; the threshold is derived from it. */
export const ROLLOVER_THRESHOLD = 16_000;
export const ROLLOVER_KEEP_RECENT = 2_000;
export const ROLLOVER_TOOLS = ["read", "context_recall"];
const WRITE_TOOLS = ["read", "write", "context_recall"];
/** The rule the `no-hint` task states once and never repeats. */
export const NO_HINT_MARKER = createHash("sha256").update("session-rollover-nohint-marker-v1").digest("hex").slice(0, 24);
/** Not derivable from the task text: only the recorded entry carries it. */
export const EXACT_DETAIL = createHash("sha256").update("session-rollover-replay-exact-detail-v1").digest("hex").slice(0, 40);
export const NO_HINT_SUMMARY_PATH = "notes/summary.md";
export const LOCKED_CONFIG_PATH = "config/locked.json";

function padded(key: string, body: string) {
	let seed = createHash("sha256").update(`rollover-replay/${key}`).digest().readUInt32LE(0);
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	const lines: string[] = [];
	let bytes = Buffer.byteLength(body) + 1;
	while (bytes < 3_072) {
		const index = lines.length;
		const line = `2026-02-0${(index % 9) + 1}T08:${String(index % 60).padStart(2, "0")}:00Z INFO worker-${next() % 32} handled batch ${next() % 10_000}; duration_ms=${next() % 900}; status=ok`;
		const lineBytes = Buffer.byteLength(line) + 1;
		if (bytes + lineBytes > 3_072) break;
		lines.push(line);
		bytes += lineBytes;
	}
	lines.splice(Math.floor(lines.length / 2), 0, body);
	return `${lines.join("\n")}\n`;
}

/** The bulk note is the one that pushes the next request past the threshold. */
const BULK = `${"filler audit line for the synthetic bulk note; no executable behavior\n".repeat(900)}`;

export type RolloverTask = {
	id: string;
	files: Readonly<Record<string, string>>;
	/** Files the scripted model reads, in order. */
	reading: readonly string[];
	/** Expected final reply text, or null when the task is graded from files only. */
	answer: string | null;
	/** Files the task creates; they are exempt from the "fixture untouched" check. */
	createdFiles: readonly string[];
	/** Extra file check for the tasks whose result is a file, not a reply. */
	verify?: (workspace: string) => Promise<boolean>;
	tools: readonly string[];
	/** Summary text the native arm may produce; it is model output, not a fixture. */
	nativeSummary: string;
	scenario: PiCodingAgentScenario;
};

function earlyDetailTask(): RolloverTask {
	const files: Record<string, string> = {
		"logs/exact.txt": padded("logs/exact.txt", `EXACT_CODE=${EXACT_DETAIL}`),
		"logs/bulk.txt": BULK,
		...Object.fromEntries(
			Array.from({ length: 6 }, (_, index) => [`notes/note-${index}.txt`, padded(`note-${index}`, `// Synthetic note ${index}; carries EVENT_CODE=synthetic-${index}, not the answer.`)]),
		),
	};
	const reading = ["logs/exact.txt", "logs/bulk.txt", ...Object.keys(files).filter((path) => path.startsWith("notes/"))];
	files["manifest.json"] = JSON.stringify(reading, null, 2);
	return Object.freeze<RolloverTask>({
		id: "early-detail",
		files: Object.freeze(files),
		reading: Object.freeze(reading),
		answer: EXACT_DETAIL,
		createdFiles: Object.freeze([]),
		tools: Object.freeze([...ROLLOVER_TOOLS]),
		nativeSummary: "## Goal\nFinish the synthetic audit.\n## Progress\nFiles were read; the requested value is not repeated here.\n## Next steps\nAnswer the follow-up.",
		scenario: {
			id: "early-detail",
			steps: [
				{
					type: "prompt",
					content:
						"Read manifest.json, then read every listed file individually and in order. Do not edit files. When you have read them all, reply READY. A separate follow-up will ask for one recorded value.",
				},
				{ type: "prompt", content: "Reply with the exact 40-character EXACT_CODE you recorded earlier. No explanation, no other text." },
			],
		},
	});
}

/**
 * The rule is stated once, in the first turn, and the second turn neither repeats nor hints at it.
 * The second turn reads the bulk note, so the compaction happens in the middle of that turn.
 */
function noHintTask(): RolloverTask {
	const notes = Object.fromEntries(
		Array.from({ length: 5 }, (_, index) => [`notes/note-${index}.txt`, padded(`note-${index}`, `// Synthetic audit note ${index}; no executable behavior.`)]),
	);
	const files: Record<string, string> = { ...notes, "logs/bulk.txt": BULK, [LOCKED_CONFIG_PATH]: `{"locked": true, "note": "must not change"}\n` };
	const reading = ["manifest.json", "logs/bulk.txt", LOCKED_CONFIG_PATH, ...Object.keys(notes)];
	files["manifest.json"] = JSON.stringify(reading, null, 2);
	return Object.freeze<RolloverTask>({
		id: "no-hint",
		files: Object.freeze(files),
		reading: Object.freeze(reading),
		answer: "DONE",
		createdFiles: Object.freeze([NO_HINT_SUMMARY_PATH]),
		async verify(workspace: string) {
			let created: string;
			try {
				created = await readFile(join(workspace, NO_HINT_SUMMARY_PATH), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
			const [first, ...rest] = created.split("\n");
			if (first !== NO_HINT_MARKER) return false;
			const listed = rest.join("\n");
			return [LOCKED_CONFIG_PATH, "logs/bulk.txt", ...Object.keys(notes)].every((path) => listed.includes(path));
		},
		tools: Object.freeze([...WRITE_TOOLS]),
		nativeSummary: `## Goal\nAudit the listed files and write ${NO_HINT_SUMMARY_PATH}.\n## Constraints\nEvery new file starts with ${NO_HINT_MARKER}. ${LOCKED_CONFIG_PATH} must not change.\n## Progress\nFiles were read.`,
		scenario: {
			id: "no-hint",
			steps: [
				{
					type: "prompt",
					content: `Project rule, stated once: the first line of every new file must be exactly ${NO_HINT_MARKER}, and ${LOCKED_CONFIG_PATH} must never change. Reply OK.`,
				},
				{
					type: "prompt",
					content: `Read manifest.json, then read every listed file individually and in order. Then create ${NO_HINT_SUMMARY_PATH} listing the files you read, one per line. Do not modify any other file. Reply DONE.`,
				},
			],
		},
	});
}

export const ROLLOVER_TASKS: readonly RolloverTask[] = Object.freeze([earlyDetailTask(), noHintTask()]);

export function taskById(id: string): RolloverTask {
	const found = ROLLOVER_TASKS.find((task) => task.id === id);
	if (!found) throw new Error(`Unknown rollover task: ${id}`);
	return found;
}

export async function writeRolloverFixture(workspace: string, selected: RolloverTask) {
	for (const [path, content] of Object.entries(selected.files)) {
		await mkdir(dirname(join(workspace, path)), { recursive: true });
		await writeFile(join(workspace, path), content);
	}
}

/** The reply must match, no fixture byte may change, and a file task must satisfy its own check. */
export async function gradeRollover(selected: RolloverTask, workspace: string, response: string): Promise<boolean> {
	if (selected.answer !== null && response.trim() !== selected.answer) return false;
	for (const [path, original] of Object.entries(selected.files)) {
		if (selected.createdFiles.includes(path)) continue;
		let actual: string;
		try {
			actual = await readFile(join(workspace, path), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		if (actual !== original) return false;
	}
	return selected.verify ? await selected.verify(workspace) : true;
}

/**
 * Why a run was graded wrong, as a short token. The reply and fixture checks are repeated here so the
 * recorded reason always matches the recorded verdict; nothing about the created file's content other
 * than its first line is kept.
 */
export async function rolloverGradeReason(selected: RolloverTask, workspace: string, response: string): Promise<string> {
	if (selected.answer !== null && response.trim() !== selected.answer) return "reply-mismatch";
	for (const [path, original] of Object.entries(selected.files)) {
		if (selected.createdFiles.includes(path)) continue;
		try {
			if ((await readFile(join(workspace, path), "utf8")) !== original) return "fixture-changed";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "fixture-missing";
			throw error;
		}
	}
	if (!selected.verify) return "unknown";
	let created: string;
	try {
		created = await readFile(join(workspace, NO_HINT_SUMMARY_PATH), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "summary-missing";
		throw error;
	}
	return created.split("\n")[0] === NO_HINT_MARKER ? "summary-incomplete" : "first-line-mismatch";
}
