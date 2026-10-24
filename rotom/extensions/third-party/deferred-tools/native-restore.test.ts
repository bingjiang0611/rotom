import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "../../../../packages/rotom-pi/packages/ai/src/index.ts";
import { createHarness } from "../../../../packages/rotom-pi/packages/coding-agent/test/suite/harness.ts";
import { DEFERRED_INITIAL_TOOL_NAMES, DEFERRED_TOOL_STATE_ENTRY, isDeferredByDefault, registerDeferredTools } from "./register.ts";

// Run after the fork's offline workspace build. The provider and tools are local
// fixtures; loadout persistence and navigation use the real AgentSession.
const environment = { ROTOM_DEFERRED_DEFAULT_SURFACE: "1" };
function productTools(pi: any): void {
	for (const name of [...DEFERRED_INITIAL_TOOL_NAMES, "subagent", "subagent_wait"]) {
		pi.registerTool({
			name, label: name, description: name, parameters: { type: "object", properties: {} },
			defaultActive: !isDeferredByDefault(name, environment),
			execute: async () => ({ content: [], details: {} }),
		});
	}
	registerDeferredTools(pi, environment);
}

for (const discover of [false, true]) {
	test(`native tree restoration preserves deferred discovery=${discover}`, async () => {
		let extensionApi: any;
		const harness = await createHarness({ tools: [], extensionFactories: [productTools, (pi) => { extensionApi = pi; }] });
		try {
			await harness.session.bindExtensions({});
			assert.equal(harness.session.getActiveToolNames().includes("subagent"), false);
			harness.setResponses([fauxAssistantMessage("first")]);
			await harness.session.prompt("first");
			const firstAssistant = harness.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
			harness.setResponses(discover ? [
				fauxAssistantMessage([fauxToolCall("search_tools", { query: "subagent" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("discovered"),
			] : [fauxAssistantMessage("second")]);
			await harness.session.prompt("second");
			// A genuinely new ordinary extension must still receive upstream's fix.
			extensionApi.registerTool({ name: "new_extension", label: "new", description: "new", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });
			await harness.session.navigateTree(firstAssistant.id);
			for (const name of ["subagent", "subagent_wait"]) assert.equal(harness.session.getActiveToolNames().includes(name), discover, name);
			assert.ok(harness.session.getActiveToolNames().includes("new_extension"));
			assert.equal(harness.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === DEFERRED_TOOL_STATE_ENTRY), false, "navigation must not copy discovery onto the selected branch");

			const replacement = await createHarness({ tools: [], sessionManager: harness.sessionManager, extensionFactories: [productTools] });
			try {
				await replacement.session.bindExtensions({});
				assert.equal(replacement.session.getActiveToolNames().includes("subagent"), false, "a replacement derives only its selected branch");
			} finally { replacement.cleanup(); }
		} finally { harness.cleanup(); }
	});
}

test("native resume restores a discovered capability from its selected branch", async () => {
	const original = await createHarness({ tools: [], extensionFactories: [productTools] });
	try {
		await original.session.bindExtensions({});
		original.setResponses([
			fauxAssistantMessage([fauxToolCall("search_tools", { query: "subagent" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await original.session.prompt("discover");
		const resumed = await createHarness({ tools: [], sessionManager: original.sessionManager, extensionFactories: [productTools] });
		try {
			await resumed.session.bindExtensions({});
			assert.ok(resumed.session.getActiveToolNames().includes("subagent"));
			assert.ok(resumed.session.getActiveToolNames().includes("subagent_wait"));
		} finally { resumed.cleanup(); }
	} finally { original.cleanup(); }
});
