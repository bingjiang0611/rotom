import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
	fuzzyFilter: (items: unknown[]) => items,
}));

import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { restoreStdout, takeOverStdout } from "../src/core/output-guard.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		baseUrl: "https://example.test",
	};
}

describe("JSON model listing", () => {
	afterEach(() => { restoreStdout(); vi.restoreAllMocks(); });

	it.each([false, true])("emits JSON only on real stdout, takeover=%s", async (takeover) => {
		const models = [model("zeta", "model-b"), model("alpha", "model-a")];
		const runtime = {
			getError: () => undefined,
			getAvailable: async () => models,
		} as unknown as ModelRuntime;
		const output: string[] = [], diagnostics: string[] = [];
		const capture = (destination: string[]) => ((chunk: string, callback?: () => void) => {
			destination.push(String(chunk)); callback?.(); return true;
		}) as typeof process.stdout.write;
		vi.spyOn(process.stdout, "write").mockImplementation(capture(output));
		vi.spyOn(process.stderr, "write").mockImplementation(capture(diagnostics));
		if (takeover) { takeOverStdout(); process.stdout.write("diagnostic\n"); }

		await listModels(runtime, undefined, undefined, { json: true, defaultModel: models[0] });

		expect(output.join("").trim().split("\n")).toHaveLength(1);
		expect(diagnostics.join("")).toBe(takeover ? "diagnostic\n" : "");
		expect(JSON.parse(output.join(""))).toEqual({
			models: [
				expect.objectContaining({ id: "alpha/model-a", contextWindow: 128000, maxTokens: 4096 }),
				expect.objectContaining({ id: "zeta/model-b", contextWindow: 128000, maxTokens: 4096 }),
			],
			defaultModel: "zeta/model-b",
		});
	});
});
