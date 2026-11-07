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

const mismatched = { protocolVersion: HELPER_PROTOCOL_VERSION - 1, executablePath: HELPER_APP_EXECUTABLE_PATH } as PlatformDiagnostics;
const current = { protocolVersion: HELPER_PROTOCOL_VERSION, executablePath: HELPER_APP_EXECUTABLE_PATH } as PlatformDiagnostics;

test("a mismatched helper is restarted only after the person says yes, then rechecked", async () => {
	const helper = new MacosHelperClient();
	let running = mismatched, restarts = 0, asked = 0;
	helper.diagnosticsCommand = async () => running;
	helper.restart = async () => { restarts++; running = current; };
	const result = await helper.ensureProtocolWithConsent(async (seen) => { asked++; assert.equal(seen.protocolVersion, HELPER_PROTOCOL_VERSION - 1); return true; });
	assert.equal(result, current);
	assert.deepEqual({ asked, restarts }, { asked: 1, restarts: 1 });
});

test("declining keeps the helper, says Computer Use is unavailable, and is not asked again", async () => {
	const helper = new MacosHelperClient();
	let restarts = 0, asked = 0;
	helper.diagnosticsCommand = async () => mismatched;
	helper.restart = async () => { restarts++; };
	const confirm = async () => { asked++; return false; };
	await assert.rejects(helper.ensureProtocolWithConsent(confirm), /unavailable in this session.*Do not call Computer Use tools again/);
	await assert.rejects(helper.ensureProtocolWithConsent(confirm), /running helper was not restarted/);
	assert.deepEqual({ asked, restarts }, { asked: 1, restarts: 0 });
});

test("without a UI the mismatched helper is never restarted", async () => {
	const helper = new MacosHelperClient();
	let restarts = 0;
	helper.diagnosticsCommand = async () => mismatched;
	helper.restart = async () => { restarts++; };
	await assert.rejects(helper.ensureProtocolWithConsent(undefined), /running helper was not restarted/);
	assert.equal(restarts, 0);
});

test("a restart that still leaves a mismatch reports it and does not ask again", async () => {
	const helper = new MacosHelperClient();
	let restarts = 0, asked = 0;
	helper.diagnosticsCommand = async () => mismatched;
	helper.restart = async () => { restarts++; };
	const confirm = async () => { asked++; return true; };
	await assert.rejects(helper.ensureProtocolWithConsent(confirm), /running helper was not restarted/);
	await assert.rejects(helper.ensureProtocolWithConsent(confirm), /running helper was not restarted/);
	assert.deepEqual({ asked, restarts }, { asked: 1, restarts: 1 });
});
