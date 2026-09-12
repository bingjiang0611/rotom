import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * Turns dead-end read/edit failures into repairable ones.
 *
 * The prompt already tells the agent to preflight paths and to prove a unique
 * match before editing, and today's traces still show the same two dead ends:
 * `read` ENOENT on a guessed path, and `edit` rejecting oldText as missing or
 * ambiguous. Repeating the instruction does not add information; the missing
 * piece is evidence at the failure point. These hints only read the local
 * filesystem the tool already touched, never mutate anything, and stay bounded
 * so an error result cannot grow into a second file dump.
 */

export const REPAIR_HINT_PREFIX = "Repair hint:";

const MAX_PROBE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 400;
const MAX_SUGGESTIONS = 6;
const MAX_REPORTED_LINES = 8;
const MAX_LINE_PREVIEW = 160;
const MAX_LEVENSHTEIN_INPUT = 64;

function textOf(content: readonly unknown[] | undefined): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("\n");
}

function preview(line: string): string {
	const collapsed = line.replace(/\t/gu, "    ");
	return collapsed.length > MAX_LINE_PREVIEW ? `${collapsed.slice(0, MAX_LINE_PREVIEW)}…` : collapsed;
}

function levenshtein(a: string, b: string): number {
	if (a.length > MAX_LEVENSHTEIN_INPUT || b.length > MAX_LEVENSHTEIN_INPUT) return Number.POSITIVE_INFINITY;
	let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length];
}

function similarNames(target: string, candidates: readonly string[]): string[] {
	const wanted = target.toLowerCase();
	const scored: { name: string; score: number }[] = [];
	for (const candidate of candidates) {
		const lowered = candidate.toLowerCase();
		if (lowered === wanted) scored.push({ name: candidate, score: 0 });
		else if (lowered.includes(wanted) || wanted.includes(lowered)) scored.push({ name: candidate, score: 1 });
		else {
			const distance = levenshtein(wanted, lowered);
			if (distance <= Math.max(2, Math.floor(wanted.length / 4))) scored.push({ name: candidate, score: 2 + distance });
		}
	}
	return scored.sort((left, right) => left.score - right.score || left.name.localeCompare(right.name)).slice(0, MAX_SUGGESTIONS).map((entry) => entry.name);
}

function listDirectory(directory: string): string[] | undefined {
	try {
		return readdirSync(directory).slice(0, MAX_DIRECTORY_ENTRIES);
	} catch {
		return undefined;
	}
}

function deepestExistingAncestor(target: string): string | undefined {
	let current = dirname(target);
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return current;
}

export function missingPathHint(target: string): string | undefined {
	if (!target || existsSync(target)) return undefined;
	const ancestor = deepestExistingAncestor(target);
	if (!ancestor) return `${REPAIR_HINT_PREFIX} '${target}' does not exist and no ancestor directory of it exists either. Re-establish the target repository root before retrying.`;
	const entries = listDirectory(ancestor);
	const leafMissing = ancestor === dirname(target);
	const stem = leafMissing ? basename(target) : target.slice(ancestor.length + 1).split(/[\\/]/u)[0];
	const suggestions = entries ? similarNames(stem, entries) : [];
	const where = leafMissing ? "the file does not exist in that directory" : `the path segment '${stem}' under it does not exist`;
	const nearby = suggestions.length > 0
		? ` Similar existing names there: ${suggestions.join(", ")}.`
		: entries && entries.length > 0
			? ` That directory holds ${entries.length}${entries.length === MAX_DIRECTORY_ENTRIES ? "+" : ""} entries and none resembles '${stem}'.`
			: "";
	return `${REPAIR_HINT_PREFIX} deepest existing directory is '${ancestor}' and ${where}.${nearby} Locate the real path with ls/rg before reading again; do not retry the same path.`;
}

/** Mirrors the tolerance the edit tool itself applies before it reports a miss. */
function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/gu, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");
}

function lineOf(content: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) if (content[cursor] === "\n") line += 1;
	return line;
}

function occurrenceLines(content: string, needle: string, atLineStart = false): number[] {
	const lines: number[] = [];
	if (!needle) return lines;
	let from = 0;
	let examined = 0;
	while (lines.length <= MAX_REPORTED_LINES && examined < 1_000) {
		const index = content.indexOf(needle, from);
		if (index === -1) break;
		examined += 1;
		if (!atLineStart || index === 0 || content[index - 1] === "\n") {
			const line = lineOf(content, index);
			// Repeated matches inside one line would otherwise print "lines 7, 7, 7".
			if (lines[lines.length - 1] !== line) lines.push(line);
		}
		from = index + 1;
	}
	return lines;
}

function readProbe(path: string): string | undefined {
	try {
		if (statSync(path).size > MAX_PROBE_FILE_BYTES) return undefined;
		return normalizeForFuzzyMatch(readFileSync(path, "utf8").replace(/\r\n/gu, "\n"));
	} catch {
		return undefined;
	}
}

function oldTextAt(input: Record<string, unknown>, index: number): string | undefined {
	const edits = Array.isArray(input.edits) ? input.edits : undefined;
	if (edits) {
		const edit = edits[index];
		const oldText = edit && typeof edit === "object" ? (edit as { oldText?: unknown }).oldText : undefined;
		return typeof oldText === "string" ? normalizeForFuzzyMatch(oldText.replace(/\r\n/gu, "\n")) : undefined;
	}
	if (index !== 0) return undefined;
	return typeof input.oldText === "string" ? normalizeForFuzzyMatch(input.oldText.replace(/\r\n/gu, "\n")) : undefined;
}

function ambiguousMatchHint(content: string, oldText: string): string {
	const lines = occurrenceLines(content, oldText);
	const shown = lines.slice(0, MAX_REPORTED_LINES);
	const listed = shown.length === 0
		? "the occurrences could not be located again"
		: `it starts at line${shown.length > 1 ? "s" : ""} ${shown.join(", ")}${lines.length > MAX_REPORTED_LINES ? ", …" : ""}`;
	return `${REPAIR_HINT_PREFIX} ${listed} (1-based). Anchor the edit by extending oldText with adjacent unique context such as the enclosing declaration, or split it into disjoint edits that each target one of those regions.`;
}

function missingMatchHint(content: string, oldText: string): string | undefined {
	const wanted = oldText.split("\n");
	let matched = 0;
	while (matched < wanted.length) {
		const candidate = wanted.slice(0, matched + 1).join("\n");
		if (occurrenceLines(content, candidate, true).length === 0) break;
		matched += 1;
	}
	const totalLines = content.split("\n").length;
	if (matched === 0) {
		const trimmed = wanted[0].trim();
		const indentationCandidates = trimmed ? occurrenceLines(content, trimmed) : [];
		if (indentationCandidates.length > 0) {
			return `${REPAIR_HINT_PREFIX} the first oldText line only matches after trimming indentation, at line${indentationCandidates.length > 1 ? "s" : ""} ${indentationCandidates.slice(0, MAX_REPORTED_LINES).join(", ")}. Leading whitespace is significant; re-read that region and copy the exact indentation.`;
		}
		return `${REPAIR_HINT_PREFIX} the first oldText line does not occur anywhere in the file (${totalLines} lines). Re-read the target region and rebuild oldText from lines that actually exist; do not resend a reconstructed snippet.`;
	}
	// Every oldText line already matches at a line start: the tool's own matcher
	// would have found it, so we have no honest divergence to report.
	if (matched >= wanted.length) return undefined;
	const anchor = wanted.slice(0, matched).join("\n");
	const anchorLine = occurrenceLines(content, anchor, true)[0];
	const contentLines = content.split("\n");
	const divergentIndex = anchorLine === undefined ? undefined : anchorLine - 1 + matched;
	const actual = divergentIndex !== undefined && divergentIndex < contentLines.length ? contentLines[divergentIndex] : undefined;
	const actualText = actual === undefined ? "end of file" : `'${preview(actual)}'`;
	return `${REPAIR_HINT_PREFIX} the first ${matched} oldText line${matched > 1 ? "s" : ""} match at line ${anchorLine}, then line ${matched + 1} diverges: oldText has '${preview(wanted[matched])}' while the file has ${actualText}. Re-read that region and correct only the divergent part.`;
}

function overlapHint(content: string, input: Record<string, unknown>, first: number, second: number): string | undefined {
	const ranges = [first, second].map((index) => {
		const oldText = oldTextAt(input, index);
		if (!oldText) return undefined;
		const start = occurrenceLines(content, oldText, true)[0];
		if (start === undefined) return undefined;
		return `edits[${index}] covers lines ${start}-${start + oldText.split("\n").length - 1}`;
	});
	if (ranges.some((range) => range === undefined)) return undefined;
	return `${REPAIR_HINT_PREFIX} ${ranges.join(" and ")}. Merge them into one edit spanning the union, or shrink each oldText so the regions are disjoint.`;
}

export function editErrorHint(input: Record<string, unknown>, errorText: string, cwd: string | undefined): string | undefined {
	const rawPath = typeof input.path === "string" ? input.path : undefined;
	if (!rawPath) return undefined;
	const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath);
	if (!existsSync(absolutePath)) return missingPathHint(absolutePath);
	const overlap = /edits\[(\d+)\] and edits\[(\d+)\] overlap/u.exec(errorText);
	const content = readProbe(absolutePath);
	if (!content) return undefined;
	if (overlap) return overlapHint(content, input, Number(overlap[1]), Number(overlap[2]));
	const indexMatch = /edits\[(\d+)\]/u.exec(errorText);
	const index = indexMatch ? Number(indexMatch[1]) : 0;
	const oldText = oldTextAt(input, index);
	if (!oldText) return undefined;
	if (/^Found \d+ occurrences of/mu.test(errorText)) return ambiguousMatchHint(content, oldText);
	if (/^Could not find /mu.test(errorText)) return missingMatchHint(content, oldText);
	return undefined;
}

export function readErrorHint(input: Record<string, unknown>, errorText: string, cwd: string | undefined): string | undefined {
	const reported = /ENOENT: no such file or directory, [a-z]+ '([^']+)'/u.exec(errorText)?.[1];
	const rawPath = reported ?? (typeof input.path === "string" ? input.path : undefined);
	if (!rawPath) return undefined;
	const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath);
	return missingPathHint(absolutePath);
}

/**
 * Returns the appended hint text, or undefined when the failure carries no
 * evidence we can add. Callers must treat undefined as "leave the result
 * untouched" so unrelated tool errors stay verbatim.
 */
export function toolErrorRepairHint(toolName: string, input: unknown, content: readonly unknown[] | undefined, cwd: string | undefined): string | undefined {
	if (toolName !== "read" && toolName !== "edit") return undefined;
	const parameters = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
	if (!parameters) return undefined;
	const errorText = textOf(content);
	if (errorText.includes(REPAIR_HINT_PREFIX)) return undefined;
	try {
		return toolName === "read" ? readErrorHint(parameters, errorText, cwd) : editErrorHint(parameters, errorText, cwd);
	} catch {
		// Diagnosis is an optional add-on: never convert a tool error into an
		// extension failure.
		return undefined;
	}
}
