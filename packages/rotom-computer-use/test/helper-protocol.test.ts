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
		await assert.rejects(helper.ensureProtocol(), /rotom helper update.*新开 rotom 会话/);
		assert.equal(restarts, 0);
	});
}

test("the matching helper is accepted without confirmation or restart", async () => {
	const helper = new MacosHelperClient();
	const diagnostics = { protocolVersion: HELPER_PROTOCOL_VERSION, executablePath: HELPER_APP_EXECUTABLE_PATH } as PlatformDiagnostics;
	helper.diagnosticsCommand = async () => diagnostics;
	helper.restart = async () => assert.fail("must not restart");
	assert.equal(await helper.ensureProtocolWithConsent(async () => assert.fail("must not ask")), diagnostics);
});

const mismatched = { protocolVersion: HELPER_PROTOCOL_VERSION - 1, executablePath: HELPER_APP_EXECUTABLE_PATH } as PlatformDiagnostics;

for (const decision of [true, false, undefined]) test(`mismatch decision ${decision}: stop only on consent, never restart or retry in this session`, async () => {
	const helper = new MacosHelperClient();
	let asked = 0, probes = 0;
	const commands: string[] = [];
	helper.diagnosticsCommand = async () => { probes++; return mismatched; };
	helper.restart = async () => assert.fail("must not restart old binary");
	helper.launchDaemon = async () => assert.fail("must not launch old binary");
	helper.daemonCommand = async <T>(cmd: string) => { commands.push(cmd); return { shuttingDown: true } as T; };
	const confirm = decision === undefined ? undefined : async (seen: PlatformDiagnostics) => {
		asked++;
		assert.equal(seen, mismatched);
		assert.deepEqual(commands, []);
		return decision;
	};
	await assert.rejects(helper.ensureProtocolWithConsent(confirm), /rotom helper update.*新开 rotom 会话/);
	await assert.rejects(helper.ensureProtocolWithConsent(confirm), /Do not call Computer Use tools again/);
	await assert.rejects(helper.command("diagnostics"), /rotom helper update/);
	assert.equal(asked, decision === undefined ? 0 : 1);
	assert.equal(probes, 1);
	assert.deepEqual(commands, decision === true ? ["shutdown"] : []);
});

test("cancellation during confirmation never dispatches shutdown", async () => {
	const helper = new MacosHelperClient();
	const controller = new AbortController();
	helper.diagnosticsCommand = async () => mismatched;
	helper.daemonCommand = async () => assert.fail("must not dispatch after cancellation");
	helper.launchDaemon = async () => assert.fail("must not launch after cancellation");
	await assert.rejects(helper.ensureProtocolWithConsent(async () => { controller.abort(); return true; }, controller.signal), /Operation aborted/);
});

test("unacknowledged shutdown stays unknown and is neither retried nor followed by a launch", async () => {
	const helper = new MacosHelperClient();
	let stops = 0;
	helper.diagnosticsCommand = async () => mismatched;
	helper.daemonCommand = async () => { stops++; throw new Error("ack lost"); };
	helper.launchDaemon = async () => assert.fail("must not launch");
	await assert.rejects(helper.ensureProtocolWithConsent(async () => true), /rotom helper update.*shutdown was not confirmed/);
	await assert.rejects(helper.ensureProtocolWithConsent(async () => assert.fail("must not ask again")), /shutdown was not confirmed/);
	await assert.rejects(helper.command("diagnostics"), /shutdown was not confirmed/);
	assert.equal(stops, 1);
});
