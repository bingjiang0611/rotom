import * as ai from "@earendil-works/pi-ai";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import * as catalog from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import * as codingAgent from "../src/index.ts";

describe("physical chat and image capabilities", () => {
	it("does not export classifier or virtual-routing APIs", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		for (const target of [ai.createModels(), runtime, new ModelRegistry(runtime)]) {
			expect("classify" in target).toBe(false);
			expect("registerVirtualModel" in target).toBe(false);
			expect("unregisterVirtualModel" in target).toBe(false);
		}
		expect(catalog).not.toHaveProperty("getBuiltinClassifierModel");
		expect(catalog).not.toHaveProperty("getBuiltinClassifierModels");
		expect(codingAgent).not.toHaveProperty("VIRTUAL_MODEL_STATE_ENTRY");
		expect(catalog.getBuiltinProviders()).not.toContain("typesafe");
		expect(runtime.getAllModels().every((model) => ["chat", "image"].includes(ai.getModelType(model)))).toBe(true);
		expect(runtime.getModels().length).toBeGreaterThan(0);
		expect(runtime.getModelsOfType("image").length).toBeGreaterThan(0);
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
