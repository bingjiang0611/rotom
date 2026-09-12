import { expect, it } from "vitest";
import { ownershipHandoffCases, scoreOwnershipHandoff } from "../src/ownership-handoff-cases.ts";

it("freezes eight cases including two canaries, with strict failure accounting", () => {
	expect(ownershipHandoffCases).toHaveLength(8);
	expect(ownershipHandoffCases.filter((item) => item.canary)).toHaveLength(2);
	for (const item of ownershipHandoffCases) {
		const correct = { ...item.expected, launchReplacement: false, replayWrite: false, publishLate: false, handoff: item.evidence.join("; ") };
		expect(scoreOwnershipHandoff(item.id, JSON.stringify(correct)).score).toBe(1);
		for (const corruption of [{ workState: "completed" }, { launchReplacement: true }, { publishLate: true }, { replayWrite: true }, { handoff: "tests passed" }]) {
			expect(scoreOwnershipHandoff(item.id, JSON.stringify({ ...correct, ...corruption })).score).toBeLessThan(1);
		}
		expect(scoreOwnershipHandoff(item.id, "not JSON").score).toBe(0);
	}
});
