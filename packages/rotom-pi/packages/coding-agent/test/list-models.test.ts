import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
	fuzzyFilter: (items: unknown[]) => items,
}));

import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

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
	afterEach(() => vi.restoreAllMocks());

	it("emits non-sensitive models and the resolver-selected default", async () => {
		const models = [model("zeta", "model-b"), model("alpha", "model-a")];
		const runtime = {
			getError: () => undefined,
			getAvailable: async () => models,
		} as unknown as ModelRuntime;
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => output.push(String(line)));

		await listModels(runtime, undefined, undefined, { json: true, defaultModel: models[0] });

		expect(JSON.parse(output[0]!)).toEqual({
			models: [
				expect.objectContaining({ id: "alpha/model-a", contextWindow: 128000, maxTokens: 4096 }),
				expect.objectContaining({ id: "zeta/model-b", contextWindow: 128000, maxTokens: 4096 }),
			],
			defaultModel: "zeta/model-b",
		});
	});
});
