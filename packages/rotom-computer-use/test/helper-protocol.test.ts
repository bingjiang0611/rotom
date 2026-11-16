import assert from "node:assert/strict";
import { test } from "node:test";
import { HELPER_APP_EXECUTABLE_PATH, HELPER_PROTOCOL_VERSION, MacosHelperClient } from "../src/platform/macos/helper.ts";
import { ensureMacosReady } from "../src/platform/macos/permissions.ts";
import { macosHelper } from "../src/platform/macos/helper.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlatformDiagnostics } from "../src/platform/types.ts";

for (const [protocolVersion, executablePath] of [
	[HELPER_PROTOCOL_VERSION - 1, HELPER_APP_EXECUTABLE_PATH],
	[HELPER_PROTOCOL_VERSION, "/not-the-selected-helper/bridge"],
] as const) {
	test(`protocol/path mismatch is sticky and never asks, shuts down or restarts another session's helper (${protocolVersion})`, async () => {
		const helper = new MacosHelperClient();
		let probes = 0;
		helper.diagnosticsCommand = async () => { probes++; return { protocolVersion, executablePath } as PlatformDiagnostics; };
		helper.restart = async () => assert.fail("must not restart");
		helper.launchDaemon = async () => assert.fail("must not launch");
		helper.daemonCommand = async () => assert.fail("must not dispatch shutdown or any other command");
		await assert.rejects(helper.ensureProtocol(), /rotom helper update.*新开 rotom 会话/);
		await assert.rejects(helper.ensureProtocol(), /Do not call Computer Use tools again/);
		await assert.rejects(helper.command("diagnostics"), /rotom helper update/);
		assert.equal(probes, 1, "a mismatched helper is not retried in this session");
	});
}

test("the matching helper is accepted without confirmation or restart", async () => {
	const helper = new MacosHelperClient();
	const diagnostics = { protocolVersion: HELPER_PROTOCOL_VERSION, executablePath: HELPER_APP_EXECUTABLE_PATH } as PlatformDiagnostics;
	helper.diagnosticsCommand = async () => diagnostics;
	helper.restart = async () => assert.fail("must not restart");
	assert.equal(await helper.ensureProtocol(), diagnostics);
});

test("normal macOS readiness does not show a helper stop authorization dialog on mismatch", async (t) => {
	const mismatch = new Error("fixture protocol mismatch");
	t.mock.method(macosHelper, "ensureInstalled", async () => undefined);
	t.mock.method(macosHelper, "ensureDaemon", async () => true);
	t.mock.method(macosHelper, "ensureProtocol", async () => { throw mismatch; });
	const ctx = { hasUI: true, ui: {
		confirm: async () => assert.fail("must not ask for authorization"),
		select: async () => assert.fail("must not ask for authorization"),
	} } as unknown as ExtensionContext;
	await assert.rejects(ensureMacosReady(ctx, { lastPermissionCheckAt: 0 }), error => error === mismatch);
});
