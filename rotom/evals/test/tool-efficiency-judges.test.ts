import { expect, it } from "vitest";
import { acceptsFailedCheckResponse } from "../cases/tool-efficiency.eval.ts";

it("accepts the same failure evidence as plain text or Markdown", () => {
	for (const response of [
		"Failed: src/widget.mjs:73 EXPECTED=314 ACTUAL=271",
		"**Failed**\n- Source: `src/widget.mjs:73`\n- **EXPECTED:** `314`\n- **ACTUAL:** `271`",
	]) expect(acceptsFailedCheckResponse(response)).toBe(true);
});

it("does not accept missing, reversed or wrong failure evidence", () => {
	for (const response of [
		"Failed: src/widget.mjs:73 EXPECTED=271 ACTUAL=314",
		"Failed: src/widget.mjs:73 EXPECTED=314",
		"Failed: src/widget.mjs:74 EXPECTED=314 ACTUAL=271",
		"Passed: src/widget.mjs:73 EXPECTED=314 ACTUAL=271",
	]) expect(acceptsFailedCheckResponse(response)).toBe(false);
});
