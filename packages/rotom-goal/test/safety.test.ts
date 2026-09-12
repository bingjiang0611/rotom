import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fingerprintAutomaticRunProgress,
	fingerprintVisibleAssistantOutput,
	nextToolFreeRepeatState,
	toolCallSignature,
} from "../src/safety.ts";

const asText = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];
const withToolCall = (text: string, name: string, args: unknown) => [
	{
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", name, arguments: args },
		],
	},
];

test("repeated identical failing tool call trips the no-progress guard", () => {
	const messages = withToolCall("retrying the failing build", "bash", { command: "npm test" });
	let state = { toolFreeRepeatCount: 0 } as {
		toolFreeRepeatCount: number;
		lastToolFreeOutputFingerprint?: string;
	};
	for (let i = 0; i < 3; i++) state = nextToolFreeRepeatState(state, messages, true);
	assert.equal(state.toolFreeRepeatCount, 3, "identical (text + tool-call) runs must accumulate");
});

test("changing tool arguments counts as progress and resets the guard", () => {
	let state = { toolFreeRepeatCount: 0 } as {
		toolFreeRepeatCount: number;
		lastToolFreeOutputFingerprint?: string;
	};
	state = nextToolFreeRepeatState(state, withToolCall("try a", "bash", { command: "a" }), true);
	state = nextToolFreeRepeatState(state, withToolCall("try a", "bash", { command: "a" }), true);
	assert.equal(state.toolFreeRepeatCount, 2);
	state = nextToolFreeRepeatState(state, withToolCall("try b", "bash", { command: "b" }), true);
	assert.equal(state.toolFreeRepeatCount, 1, "new arguments must reset the repeat counter");
});

test("argument key order does not matter (stable signature)", () => {
	const a = toolCallSignature(withToolCall("x", "edit", { path: "p", text: "t" }));
	const b = toolCallSignature(withToolCall("x", "edit", { text: "t", path: "p" }));
	assert.equal(a, b);
});

test("tool-free runs preserve the exact upstream text fingerprint", () => {
	// With no tool call and toolAttempted=false the combined fingerprint must
	// equal the upstream tool-free fingerprint, so persisted counters stay valid.
	const messages = asText("still thinking, no tools used");
	assert.equal(
		fingerprintAutomaticRunProgress(messages, false),
		fingerprintVisibleAssistantOutput(messages),
	);
});

test("tool-free identical output still accumulates like upstream", () => {
	const messages = asText("i am stuck");
	let state = { toolFreeRepeatCount: 0 } as {
		toolFreeRepeatCount: number;
		lastToolFreeOutputFingerprint?: string;
	};
	for (let i = 0; i < 3; i++) state = nextToolFreeRepeatState(state, messages, false);
	assert.equal(state.toolFreeRepeatCount, 3);
});

test("opaque tool attempt does not collapse into a tool-free repeat", () => {
	// Same visible text, but one run is tool-free and the next attempts a tool
	// whose blocks are not visible: fingerprints must differ so a real tool
	// attempt is never mistaken for a tool-free repeat.
	const text = "working";
	const free = fingerprintAutomaticRunProgress(asText(text), false);
	const opaque = fingerprintAutomaticRunProgress(asText(text), true);
	assert.notEqual(free, opaque);
});
