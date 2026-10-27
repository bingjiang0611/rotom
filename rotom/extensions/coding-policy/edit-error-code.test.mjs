import assert from "node:assert/strict";
import test from "node:test";
import { classifyEditError } from "./edit-error-code.mjs";

// Product texts from the Pi fork edit tool (`core/tools/edit.ts`,
// `edit-diff.ts`), which SoL-Pi Action Fusion also serves as `edit`.
const MISSING_SINGLE = "Could not find the exact text in sample.ts. The old text must match exactly including all whitespace and newlines.";
const MISSING_MULTI = "Could not find edits[1] in sample.ts. The oldText must match exactly including all whitespace and newlines.";
const AMBIGUOUS_SINGLE = "Found 3 occurrences of the text in sample.ts. The text must be unique. Please provide more context to make it unique.";
const AMBIGUOUS_MULTI = "Found 2 occurrences of edits[0] in sample.ts. Each oldText must be unique. Please provide more context to make it unique.";
const NO_CHANGE_SINGLE = "No changes made to sample.ts. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.";
const NO_CHANGE_MULTI = "No changes made to sample.ts. The replacements produced identical content.";
const OVERLAP = "edits[0] and edits[2] overlap in sample.ts. Merge them into one edit or target disjoint regions.";
const EMPTY_SINGLE = "oldText must not be empty in sample.ts.";
const EMPTY_MULTI = "edits[1].oldText must not be empty in sample.ts.";
const INVALID_INPUT = "Edit tool input is invalid. edits must contain at least one replacement.";

test("每个真实 edit 失败文本映射到固定枚举码", () => {
	assert.equal(classifyEditError(MISSING_SINGLE), "old_text_not_found");
	assert.equal(classifyEditError(MISSING_MULTI), "old_text_not_found");
	assert.equal(classifyEditError(AMBIGUOUS_SINGLE), "old_text_ambiguous");
	assert.equal(classifyEditError(AMBIGUOUS_MULTI), "old_text_ambiguous");
	assert.equal(classifyEditError(NO_CHANGE_SINGLE), "no_change");
	assert.equal(classifyEditError(NO_CHANGE_MULTI), "no_change");
	assert.equal(classifyEditError(OVERLAP), "overlapping_edits");
	assert.equal(classifyEditError(EMPTY_SINGLE), "invalid_edit_input");
	assert.equal(classifyEditError(EMPTY_MULTI), "invalid_edit_input");
	assert.equal(classifyEditError(INVALID_INPUT), "invalid_edit_input");
});

test("edit 工具在匹配错误后追加的写入说明不影响分类", () => {
	assert.equal(classifyEditError(`${MISSING_SINGLE}\nNo edits were written by this call. Re-read the target before rebuilding the replacement.`), "old_text_not_found");
	assert.equal(classifyEditError(`Repair hint: something\n${AMBIGUOUS_SINGLE}`), "old_text_ambiguous");
});

test("文件系统错误沿用已有码，未知系统码不猜", () => {
	assert.equal(classifyEditError("Could not edit file: sample.ts. Error code: ENOENT."), "enoent");
	assert.equal(classifyEditError("Could not edit file: sample.ts. Error code: EACCES."), "eacces");
	assert.equal(classifyEditError("Could not edit file: sample.ts. Error code: EWEIRD."), undefined);
	assert.equal(classifyEditError("Could not edit file: sample.ts. No such file."), undefined);
});

test("Action Fusion 成功的 edit、abort 和不认识的文本都不写码", () => {
	assert.equal(classifyEditError("Successfully replaced 1 block(s) in sample.ts."), undefined);
	assert.equal(classifyEditError("Operation aborted"), undefined);
	assert.equal(classifyEditError("Replacement range is outside the base content."), undefined);
	assert.equal(classifyEditError("edit: some other failure"), undefined);
	assert.equal(classifyEditError(""), undefined);
	assert.equal(classifyEditError(undefined), undefined);
});
