import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { COMPACTION_SUMMARY_PREFIX, ROLLOVER_SUMMARY_PREFIX } from "../src/core/messages.ts";
import { type CompactionEntry, sessionEntryToContextMessages } from "../src/core/session-manager.ts";

function compactionEntry(details?: unknown): CompactionEntry {
	return {
		type: "compaction",
		id: "c1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		summary: "Earlier work was cleared.",
		firstKeptEntryId: "c1",
		tokensBefore: 12_345,
		...(details === undefined ? {} : { details }),
	};
}

function projectedText(entry: CompactionEntry): string {
	const message = sessionEntryToContextMessages(entry)[0];
	expect(message?.role).toBe("compactionSummary");
	const [rendered] = convertToLlm([message!]);
	const content = rendered?.content;
	if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("expected one text part");
	return content[0].text;
}

describe("rollover projection", () => {
	it("renders a rollover entry with the dedicated prefix instead of the summary prefix", () => {
		const text = projectedText(compactionEntry({ kind: "rotom-rollover", version: 2 }));
		expect(text).toContain(ROLLOVER_SUMMARY_PREFIX);
		expect(text).not.toContain(COMPACTION_SUMMARY_PREFIX);
		expect(text).toContain("Earlier work was cleared.");
	});

	it("keeps the summary prefix for a native compaction entry", () => {
		for (const details of [undefined, { kind: "something-else" }, { version: 2 }]) {
			const text = projectedText(compactionEntry(details));
			expect(text).toContain(COMPACTION_SUMMARY_PREFIX);
			expect(text).not.toContain(ROLLOVER_SUMMARY_PREFIX);
		}
	});

	it("projects the system message before the rollover entry without changing either", () => {
		const entry: CompactionEntry = {
			...compactionEntry({ kind: "rotom-rollover", version: 2 }),
			systemMessage: { role: "system", content: "kept prompt", timestamp: 0 },
		};
		const messages = sessionEntryToContextMessages(entry);
		expect(messages.map((message) => message.role)).toEqual(["system", "compactionSummary"]);
		expect((messages[0] as { content: string }).content).toBe("kept prompt");
	});
});
