import { vi } from "vitest";

// Real Vitest lifecycle, synthetic campaign: no runtime, credentials or inference.
const state = vi.hoisted(() => ({ executed: 0 }));
vi.stubGlobal("fetch", () => { throw new Error("No network in entry fixture"); });
vi.mock("../../src/compaction-offload-cases.ts", async () => ({
	...await vi.importActual("../../src/compaction-offload-cases.ts"),
	LIVE_AUTHORIZATION: { id: "entry-fixture-only", provider: "entry-faux", model: "replay", thinking: "low", maxRepetitions: 3, maxRequests: 3000, maxInputTokens: 140_000_000 },
}));
vi.mock("../../src/product-runtime.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../../src/product-runtime.ts")>(),
	loadProductRuntime: async () => ({ runtime: { getAgentDir: () => "/synthetic-source-agent" } }),
}));
vi.mock("../../src/compaction-offload-live.ts", async () => {
	const { createHarness } = await import("vitest-evals/harness");
	return { authorizedRuntimeFactory: () => () => { throw new Error("No runtime in entry fixture"); }, createLiveReplayCampaign: () => ({
		summary: () => ({ executedRuns: state.executed, unusableRuns: 3 }),
		harness: () => createHarness({ name: "entry-faux", run() {
			const index = ++state.executed;
			if (index > 4) throw new Error("Bail did not stop the campaign");
			const provider = index === 1 || index === 4;
			return { output: { status: provider ? "failed" : index === 2 ? "completed" : "invalid",
				reason: provider ? "provider-error" : index === 3 ? "threshold-not-reached" : null, metrics: { correct: !provider },
				cumulative: { stopReason: index === 4 ? "provider-error" : null } },
				events: [{ type: "message" as const, role: "user" as const, content: "synthetic case" }] };
		} }),
	}) };
});
await import("../../cases/compaction-offload.eval.ts");
