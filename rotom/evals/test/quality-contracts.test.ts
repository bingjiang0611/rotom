import { describe, expect, it } from "vitest";
import { defaultProductAgentDir } from "../src/product-runtime.ts";
import { checkQualityContracts, inspectQualityContracts } from "../src/quality-contracts.ts";

const inspect = (source: string) => inspectQualityContracts("fixture.ts", source).map(finding => finding.rule);

describe("quality contract guards", () => {
	it.each([
		"process.emitWarning = () => {};",
		'process["emitWarning"] = handler;',
		"delete process.emitWarning;",
		'Object.defineProperty(process, "emitWarning", { value() {} });',
		'Reflect.set(process, "emitWarning", handler);',
	])("rejects global warning replacement: %s", source => {
		expect(inspect(source)).toEqual(["no-global-warning-override"]);
	});

	it("allows specific warnings and unrelated local methods, not merely matching text", () => {
		expect(inspect(`
			process.emitWarning("fixture", { code: "FIXTURE_WARNING" });
			local.emitWarning = () => {};
			const documentation = "process.emitWarning = () => {}";
		`)).toEqual([]);
	});

	it.each([
		"return event.content[0].text.startsWith('Successfully replaced');",
		'return /success/.test(event["content"][0].text);',
		"const { content: blocks } = event; return blocks.length;",
	])("rejects presentation evidence in the phase reader: %s", body => {
		expect(inspect(`function codingResultPhases(event) { ${body} }`)).toContain("no-display-text-as-protocol");
	});

	it("allows versioned metadata and display processing outside the phase reader", () => {
		expect(inspect(`
			function codingResultPhases(event) { return event.details.actionFusion; }
			function render(event) { return event.content; }
		`)).toEqual([]);
	});

	it("reports the rule, location and repair boundary", () => {
		const [finding] = inspectQualityContracts("launch.mjs", "// comment\nprocess.emitWarning = () => {};\n");
		expect(finding).toMatchObject({ file: "launch.mjs", line: 2, rule: "no-global-warning-override" });
		expect(finding?.message).toContain("producer/UI boundary");
	});

	it("checks the real production entry points", () => {
		expect(checkQualityContracts(defaultProductAgentDir())).toEqual([]);
	});
});
