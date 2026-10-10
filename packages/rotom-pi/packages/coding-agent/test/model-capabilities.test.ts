import * as ai from "@earendil-works/pi-ai";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import * as catalog from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import * as codingAgent from "../src/index.ts";

describe("upstream model capabilities", () => {
	it("exports classifier and virtual-routing APIs alongside chat and image models", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		for (const target of [ai.createModels(), runtime, new ModelRegistry(runtime)]) {
			expect(typeof target.classify).toBe("function");
		}
		for (const target of [runtime, new ModelRegistry(runtime)]) {
			expect(typeof target.registerVirtualModel).toBe("function");
			expect(typeof target.unregisterVirtualModel).toBe("function");
		}
		expect(catalog).toHaveProperty("getBuiltinClassifierModel");
		expect(catalog).toHaveProperty("getBuiltinClassifierModels");
		expect(codingAgent).toHaveProperty("VIRTUAL_MODEL_STATE_ENTRY");
		expect(catalog.getBuiltinProviders()).toContain("typesafe");
		expect(runtime.getModels().length).toBeGreaterThan(0);
		expect(runtime.getModelsOfType("image").length).toBeGreaterThan(0);
		expect(runtime.getModelsOfType("classifier").length).toBeGreaterThan(0);
	});

	it("keeps ordinary branch model selection and ignores historical router state", () => {
		const session = SessionManager.inMemory();
		session.appendModelChange("fixture", "first");
		session.appendCustomEntry("pi.virtual-model-state", {
			provider: "retired",
			modelId: "auto",
			state: { phase: "edit" },
		});
		session.appendModelChange("fixture", "selected");
		expect(session.buildSessionContext().model).toEqual({ provider: "fixture", modelId: "selected" });
		expect(session.getBranch().some((entry) => entry.type === "custom")).toBe(true);
	});
});
