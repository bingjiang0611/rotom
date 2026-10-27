// Maps an edit tool failure message to a fixed enum code.
//
// The message is read only to classify it. Callers must record the returned
// code alone: never the text, a snippet, a path or an index. The patterns come
// from the product edit tool (Pi fork `core/tools/edit.ts` + `edit-diff.ts`,
// also reached through SoL-Pi Action Fusion, which re-registers the same tool as
// `edit`). Unrecognised text keeps no code, so nothing pretends to be classified.

// Node system failures keep the codes the trace already records for file tools.
const FILE_SYSTEM_CODES = new Set([
	"enoent", "eacces", "eperm", "eisdir", "enotdir", "eexist", "enospc", "emfile",
]);

const RULES = [
	["overlapping_edits", /^edits\[\d+\] and edits\[\d+\] overlap in /mu],
	["old_text_not_found", /^Could not find (?:the exact text in|edits\[\d+\] in) /mu],
	["old_text_ambiguous", /^Found \d+ occurrences of /mu],
	["no_change", /^No changes made to /mu],
	["invalid_edit_input", /^(?:Edit tool input is invalid\.|oldText must not be empty in|edits\[\d+\]\.oldText must not be empty in)/mu],
];

/** @returns the enum code for a known edit failure, or undefined. */
export function classifyEditError(errorText) {
	if (typeof errorText !== "string" || errorText.length === 0) return undefined;
	const fileSystem = /^Could not edit file: .*\bError code: ([A-Za-z0-9_]+)\./mu.exec(errorText);
	if (fileSystem) {
		const code = fileSystem[1].toLowerCase();
		return FILE_SYSTEM_CODES.has(code) ? code : undefined;
	}
	for (const [code, pattern] of RULES) if (pattern.test(errorText)) return code;
	return undefined;
}

export { FILE_SYSTEM_CODES };
