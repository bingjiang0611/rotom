import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { confirmHelperStop } from "../scripts/helper-update.mjs";

for (const answer of ["", "n", "yes"]) test(`terminal stop confirmation defaults to no: ${JSON.stringify(answer)}`, async () => {
	const input = new PassThrough(), output = new PassThrough();
	let prompt = "";
	output.once("data", (data) => {
		prompt = data.toString();
		queueMicrotask(() => input.write(answer + "\n"));
	});
	assert.equal(await confirmHelperStop({ input, output }), answer === "yes");
	assert.match(prompt, /其他 rotom 会话会失去 Computer Use.*\[y\/N\]/);
	input.destroy(); output.destroy();
});
