import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "../../../packages/rotom-pi/packages/ai/src/index.ts";
import { getCurrentSystemPrompt } from "../../../packages/rotom-pi/packages/ai/src/utils/transcript.ts";
import { createHarness } from "../../../packages/rotom-pi/packages/coding-agent/test/suite/harness.ts";
import codingPolicy, { CODING_POLICY_SECTION, CODING_POLICY_TEXT } from "./index.ts";

// Run after the fork's offline workspace build (see docs/agent/pi-1.4-migration.md).
// The provider is a local faux; the prompt plumbing is the real AgentSession.

type Captured = Array<{ role: string; content?: unknown; sections?: Record<string, string | null>; toolsAdded?: Array<{ name: string }> }>;

test("coding policy rides a stable system section; a loadout change only appends a patch", async () => {
	let api: any;
	const lateTool = (pi: any) => {
		api = pi;
		pi.registerTool({
			name: "late_tool", label: "late", description: "late", parameters: { type: "object", properties: {} },
			defaultActive: false, execute: async () => ({ content: [], details: {} }),
		});
	};
	const harness = await createHarness({ extensionFactories: [codingPolicy, lateTool] });
	try {
		await harness.session.bindExtensions({});
		const requests: Captured[] = [];
		const capture = (text: string) => (context: { messages: Captured }) => {
			requests.push(structuredClone(context.messages));
			return fauxAssistantMessage(text);
		};
		harness.setResponses([capture("one")]);
		await harness.session.prompt("first");
		api.setActiveTools([...harness.session.getActiveToolNames(), "late_tool"]);
		harness.setResponses([capture("two")]);
		await harness.session.prompt("second");
		assert.equal(requests.length, 2);

		const [first, second] = requests;
		const firstSystem = first.filter((message) => message.role === "system");
		assert.equal(firstSystem.length, 1);
		const head = firstSystem[0];
		// Structured sections, not an opaque forced prompt.
		assert.equal(head.content, "");
		assert.equal(head.sections?.[CODING_POLICY_SECTION], `<${CODING_POLICY_SECTION}>\n${CODING_POLICY_TEXT}\n</${CODING_POLICY_SECTION}>`);
		assert.ok(head.sections?.preamble, "Pi's own sections stay separate");

		// The cached prefix: the leading system message is byte-identical on the next request.
		assert.deepEqual(second[0], head);
		const patches = second.filter((message, index) => index > 0 && message.role === "system");
		assert.ok(patches.some((message) => message.toolsAdded?.some((tool) => tool.name === "late_tool")), "the new tool arrives as a later patch");
		const prompt = getCurrentSystemPrompt(second as never);
		assert.equal(prompt.split(CODING_POLICY_TEXT).length, 2, "the policy appears exactly once");
	} finally {
		harness.cleanup();
	}
});
