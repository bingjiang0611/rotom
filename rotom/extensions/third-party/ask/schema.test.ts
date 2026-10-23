import assert from "node:assert/strict";
import test from "node:test";
import { askContinuationParameters } from "./schema.ts";

function schema() { return { type: "object", properties: { questions: { type: "array", minItems: 1, items: { type: "object", properties: { options: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string", maxLength: 60 } } } } } } } } }; }
test("Ask adaptation preserves validation, metadata and source schema", () => {
	const original = schema(), before = structuredClone(original), symbol = Symbol("metadata");
	Object.assign(original, { [symbol]: "kept" });
	const result = askContinuationParameters(original);
	assert.equal((result as any)[symbol], "kept");
	const option = result.properties.questions.items.properties.options.items;
	assert.equal(option.properties.continueExecution.type, "boolean");
	assert.deepEqual(option.required, ["label"]);
	assert.equal(option.additionalProperties, false);
	assert.equal(option.properties.label.maxLength, 60);
	assert.deepEqual(JSON.parse(JSON.stringify(original)), before);
});
test("Ask adaptation rejects every missing or malformed intermediate schema node", () => {
	for (const path of [[], ["properties", "questions"], ["properties", "questions", "items"],
		["properties", "questions", "items", "properties", "options"],
		["properties", "questions", "items", "properties", "options", "items"]]) {
		for (const invalid of [undefined, {}, [], { type: "object" }]) {
			let value: any = schema();
			if (!path.length) value = invalid;
			else { let parent = value; for (const key of path.slice(0, -1)) parent = parent[key]; parent[path.at(-1)!] = invalid; }
			assert.throws(() => askContinuationParameters(value), /Unsupported ask_user_question schema/u);
		}
	}
});
