import { vi } from "vitest";

// Real Vitest lifecycle, synthetic campaign: no runtime, credentials or inference.
const state = vi.hoisted(() => ({ executed: 0 }));
vi.stubGlobal("fetch", () => { throw new Error("No network in entry fixture"); });
vi.mock("../../src/compaction-offload-cases.ts", async () => ({
	...await vi.importActual("../../src/compaction-offload-cases.ts"),
	LIVE_AUTHORIZATION: { id: "entry-fixture-only", provider: "entry-faux", model: "replay", thinking: "low", maxRepetitions: 3, maxRequests: 3000, maxInputTokens: 140_000_000 },
}));
vi.mock("../../src/compaction-offload-live.ts", async () => {
	const { createHarness } = await import("vitest-evals/harness");
	return { createLiveReplayCampaign: () => ({
		summary: () => ({ executedRuns: state.executed }),
		harness: () => createHarness({ name: "entry-faux", run() {
			const index = ++state.executed;
			if (index > 4) throw new Error("Bail did not stop the campaign");
			return { output: { status: index === 2 ? "completed" : "invalid", metrics: { correct: true },
				cumulative: { stopReason: index === 4 ? "threshold-not-reached" : null } },
				events: [{ type: "message" as const, role: "user" as const, content: "synthetic case" }] };
		} }),
	}) };
});
await import("../../cases/compaction-offload.eval.ts");
