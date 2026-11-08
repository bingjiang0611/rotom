import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserIntegrationFixture } from "./browser-test-helpers.ts";

test("browser relay：prompt/schema 合同与预算保持稳定", async () => {
	const fixture = await createBrowserIntegrationFixture();
	const { tool, interact } = fixture;
	try {
		for (const definition of [tool, interact]) {
			const policy = definition.promptGuidelines?.join("\n") ?? "";
			assert.match(policy, /Use browser_inspect\/browser_interact first.*never fall back.*shell\/OS.*mouse.*keyboard.*desktop screenshots/u);
			assert.match(policy, /untrusted data.*document-text refs are read-only/u);
			assert.match(policy, /recover the same tab once.*relayAttached=true.*at most once.*close\/open.*discover\/claim/u);
			assert.match(policy, /nextCursor.*contentCoverage=scroll-end.*contentComplete=true.*truncated=false.*rendered DOM/u);
			assert.match(policy, /CSS-viewport x\/y.*observationEpoch.*latest screenshot.*never mix ref and coordinates.*blindly replay/iu);
			assert.match(policy, /hit-tests the point before dispatch and fails closed on mismatch/u, "\u5750\u6807\u70b9\u51fb\u7684 pre-dispatch hit-test \u5fc5\u987b\u5199\u660e\uff0c\u4e0d\u80fd\u9760\u8bed\u5e8f\u6697\u793a");
			assert.match(policy, /foreground or background.*new tabs and popups stay background.*discover then claim.*downloads are not intercepted/u);
		}
		assert.match(tool.promptGuidelines?.join("\n") ?? "", /virtualized scroll containers.*restore position.*cursor pagination.*scrolledContainers>0/u);
		assert.match(tool.promptGuidelines?.join("\n") ?? "", /handoff returns.*screenshots are sensitive content/us);
		assert.match(interact.promptGuidelines?.join("\n") ?? "", /nested lists.*visible descendant ref for the nearest scroll container/u);
		assert.match(interact.promptGuidelines?.join("\n") ?? "", /acknowledged proves dispatch, not business success.*dispatchSettled=false.*moved=false.*Do not loop/u);
		assert.match(interact.promptGuidelines?.join("\n") ?? "", /page-alert nodes and effect\.target; changed=null is unknown, not unchanged.*expect \(checked.*value=empty\|nonempty\) needs a targetRef.*met is target evidence, not business success/u);
		assert.match(interact.promptGuidelines?.join("\n") ?? "", /Unknown writes may have executed.*read-only checks, never re-dispatch/u, "写动作 unknown 的不重发边界必须写在写入工具自己的指引里");
		const browserGuidelineBytes = [tool, interact].reduce((sum, definition) => sum + Buffer.byteLength(JSON.stringify(definition.promptGuidelines ?? []), "utf8"), 0);
		const browserSchemaBytes = [tool, interact].reduce((sum, definition) => sum + Buffer.byteLength(JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }), "utf8"), 0);
		// Keep prompt text bounded; schema growth exposes the fixed expectation enum
		// and operation-specific requirements instead of adding another prose checklist.
		// +100 bytes budgeted for the cross-agent transfer operation (T2): the receiver
		// name format and the fact that its refs start fresh cannot be left to the schema.
		// +82 bytes for the `placement` open value (T6): an agent window is a placement,
		// not a second open operation, so it is one clause in the existing open line.
		assert.ok(browserGuidelineBytes <= 3_835, `Browser guideline budget regressed: ${browserGuidelineBytes}`);
		// The `placement` enum adds 71 schema bytes (T6) without a second parameter.
		// `navigate` (T12) adds one operation value plus `history: back|forward|reload`,
		// and widens the `url` line to say it also serves navigate: +138 bytes, still far
		// inside the two-browser-tools budget.
		// `console` (T13) adds level/pattern/sinceCursor + the operation value: +421 bytes.
		// `network` (T14) adds `failedOnly`, `resourceType` and one operation value: +398 bytes.
		// The full key whitelist (T15) turns `key` into a 62-value enum plus `modifiers`:
		// +484 bytes. Pointer actions and `dropRef` (T16) add +163, measured 4 425. `upload`
		// (T17) adds one action value plus `paths`: +189, measured 4 614. `dialog` (T18) adds
		// the action value plus `accept`/`promptText`: +252, measured 4 866. Batches (T19) add
		// a step schema that repeats the per-action fields the model must be able to fill:
		// +1 989, measured 6 855. That is the price of documenting each step honestly instead
		// of leaving the fields undocumented; the guideline text is unchanged, so the M3
		// footprint stays well inside its 30% budget.
		assert.ok(browserSchemaBytes <= 6_950, `Browser schema budget regressed: ${browserSchemaBytes}`);
		// `action` is no longer schema-required because `actions` can replace it; the local
		// check rejects a call that carries neither (covered below).
		assert.equal(interact.parameters.properties.action.type, "string");
		assert.equal(interact.parameters.properties.actions.maxItems, 10);
		assert.equal(interact.parameters.properties.expect.enum.length, 16);
		assert.ok(interact.parameters.properties.expect.enum.includes("value=nonempty"));
		for (const invalid of ["visible", "navigation", "ack", "EPUB"]) assert.equal(interact.parameters.properties.expect.enum.includes(invalid), false);
		assert.match(tool.parameters.properties.tabName.description, /Required for open and claim/u);

	} finally {
		await fixture.cleanup();
	}
});
