import assert from "node:assert/strict";
import { test } from "node:test";
import { HELPER_APP_EXECUTABLE_PATH, HELPER_PROTOCOL_VERSION, MacosHelperClient } from "../src/platform/macos/helper.ts";
import type { PlatformDiagnostics } from "../src/platform/types.ts";

for (const [protocolVersion, executablePath] of [
	[HELPER_PROTOCOL_VERSION - 1, HELPER_APP_EXECUTABLE_PATH],
	[HELPER_PROTOCOL_VERSION, "/not-the-selected-helper/bridge"],
] as const) {
	test(`protocol/path mismatch does not restart a daemon owned by another session (${protocolVersion})`, async () => {
		const helper = new MacosHelperClient();
		let restarts = 0;
		helper.diagnosticsCommand = async () => ({ protocolVersion, executablePath }) as PlatformDiagnostics;
		helper.restart = async () => { restarts++; };
		await assert.rejects(helper.ensureProtocol(), /running helper was not restarted/);
		assert.equal(restarts, 0);
	});
}

test("the matching background-text helper is accepted without restart", async () => {
	const helper = new MacosHelperClient();
	let restarts = 0;
	const diagnostics = { protocolVersion: HELPER_PROTOCOL_VERSION, executablePath: HELPER_APP_EXECUTABLE_PATH } as PlatformDiagnostics;
	helper.diagnosticsCommand = async () => diagnostics;
	helper.restart = async () => { restarts++; };
	assert.equal(await helper.ensureProtocol(), diagnostics);
	assert.equal(restarts, 0);
});
