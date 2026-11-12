import assert from "node:assert/strict";
import { test } from "node:test";
import { inputSourceInfo } from "../scripts/lib/live-helpers.mjs";

/** Exactly what `defaults read com.apple.HIToolbox AppleSelectedInputSources` prints. */
const ONLY_ABC = `(
        {
        InputSourceKind = "Keyboard Layout";
        "KeyboardLayout ID" = 252;
        "KeyboardLayout Name" = ABC;
    }
)`;

const ABC_AND_IME = `(
        {
        InputSourceKind = "Keyboard Layout";
        "KeyboardLayout Name" = ABC;
    },
        {
        "Bundle ID" = "com.apple.PressAndHold";
        InputSourceKind = "Non Keyboard Input Method";
    },
        {
        "Bundle ID" = "com.sogou.inputmethod.sogou";
        "Input Mode" = "com.sogou.inputmethod.pinyin";
        InputSourceKind = "Input Mode";
    }
)`;

const readDefaults = (out: string) => () => out;

test("a plain layout is detected as ASCII", () => {
	// Review H1: keys with spaces are quoted in this plist, and matching only the bare
	// `KeyboardLayout Name =` form made every layout invisible, so ASCII was never true.
	assert.deepEqual(inputSourceInfo(readDefaults(ONLY_ABC)), { ascii: true, description: "layout ABC" });
});

test("an input method alongside a layout is not ASCII", () => {
	assert.deepEqual(inputSourceInfo(readDefaults(ABC_AND_IME)), {
		ascii: false,
		description: "input method com.sogou.inputmethod.pinyin,ABC",
	});
});

test("an unreadable input source is reported as not ASCII, never as safe", () => {
	const failing = () => {
		throw new Error("The domain/default pair of (com.apple.HIToolbox, AppleSelectedInputSources) does not exist");
	};
	const info = inputSourceInfo(failing as never);
	assert.equal(info.ascii, false);
	assert.match(info.description, /^unreadable \(/);
});
