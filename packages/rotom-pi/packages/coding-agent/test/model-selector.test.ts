import type { Model, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		expect(getModelRow("current-model")).toBe(`→ ✓ Current Model · current-model [${currentModel.provider}]`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`  ✓ Current Model · current-model [${currentModel.provider}]`);
		expect(getModelRow("browsed-model")).toBe(`→   Browsed Model · browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel, "off");
	});

	it("searches by name and selects the original ID, without changing the session while browsing", async () => {
		harness = await createHarness({ models: [{ id: "qfmodel", name: "Qwen3.8-Flash", reasoning: true }] });
		const selected = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			selected,
			() => {},
			"Qwen3.8",
		);
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Qwen3.8-Flash · qfmodel");
		expect(selected).not.toHaveBeenCalled();
		selector.handleInput("\r");
		expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "qfmodel", name: "Qwen3.8-Flash" }), "off");
	});

	it("keeps long names to one list row and exposes the full identity below", async () => {
		harness = await createHarness({ models: [{ id: "short-id", name: "Long 模型 ".repeat(30), reasoning: true }] });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		for (const width of [40, 80, 140]) {
			const lines = selector.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(stripAnsi(lines.join("\n"))).toContain(`Model ID: ${harness.getModel().provider}/short-id`);
			expect(stripAnsi(lines.find((line) => stripAnsi(line).startsWith("→ ")) ?? "")).toContain("...");
		}
		selector.dispose();
	});

	it("falls back to ID for a blank name and does not duplicate identical names", async () => {
		harness = await createHarness();
		const model = { ...harness.getModel(), id: "same", name: "same" };
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([model]);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			model,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		expect(stripAnsi(selector.render(100).join("\n"))).toContain(`→ ✓ same [${model.provider}]`);
		selector.dispose();
		model.name = " ";
		const blank = new ModelSelectorComponent(
			createFakeTui(),
			model,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		expect(stripAnsi(blank.render(100).join("\n"))).toContain(`→ ✓ same [${model.provider}]`);
		blank.dispose();
	});

	it("cycles a picker-local thinking draft with the configured binding and discards it on cancel", async () => {
		setKeybindings(new KeybindingsManager({ "app.thinking.cycle": "ctrl+r" }));
		harness = await createHarness({ models: [{ id: "reasoner", reasoning: true }] });
		harness.session.setThinkingLevel("medium");
		const before = harness.sessionManager.getEntries().length,
			selected = vi.fn(),
			cancelled = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			selected,
			cancelled,
			undefined,
			undefined,
			undefined,
			() => "medium",
		);
		selector.handleInput("\x1b[Z");
		expect(stripAnsi(selector.render(140).join("\n"))).toContain("[medium]");
		selector.handleInput("\x12");
		expect(stripAnsi(selector.render(140).join("\n"))).toContain("[high]");
		expect(stripAnsi(selector.render(140).join("\n"))).toContain("Ctrl+R cycles");
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(harness.sessionManager.getEntries()).toHaveLength(before);
		selector.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledOnce();
		expect(selected).not.toHaveBeenCalled();
	});

	it("confirms thinking with the original model and retains drafts across scope changes", async () => {
		harness = await createHarness({
			models: [
				{ id: "one", reasoning: true },
				{ id: "two", reasoning: true },
			],
		});
		const model = harness.getModel("one")!,
			selected = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			model,
			harness.session.modelRuntime,
			[{ model }],
			selected,
			() => {},
			undefined,
			undefined,
			undefined,
			() => "medium",
		);
		selector.handleInput("\x1b[Z");
		selector.handleInput("\t");
		selector.handleInput("\x1b[B");
		expect(stripAnsi(selector.render(140).join("\n"))).toContain("[medium]");
		selector.handleInput("\t");
		expect(stripAnsi(selector.render(140).join("\n"))).toContain("[high]");
		selector.handleInput("\r");
		expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "one" }), "high");
	});

	it("offers only declared levels, including fixed and non-reasoning models", async () => {
		harness = await createHarness();
		const fixed: Model<string> = {
			...harness.getModel(),
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: "enabled",
				high: null,
				xhigh: null,
				max: null,
			},
		};
		for (const model of [fixed, { ...fixed, reasoning: false }]) {
			vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([model]);
			const selected = vi.fn();
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				model,
				harness.session.modelRuntime,
				[],
				selected,
				() => {},
			);
			selector.handleInput("\x1b[Z");
			const rendered = stripAnsi(selector.render(140).join("\n"));
			expect(rendered).toContain(
				model.reasoning ? "Thinking: [medium] · fixed by model/provider" : "Thinking: [off] · not supported",
			);
			expect(rendered).not.toContain("cycles");
			selector.handleInput("\r");
			expect(selected).toHaveBeenCalledWith(model, model.reasoning ? "medium" : "off");
		}
	});

	it("revalidates drafted levels when a refresh changes capabilities", async () => {
		harness = await createHarness({ models: [{ id: "reasoner", reasoning: true }] });
		let model: Model<string> = { ...harness.getModel(), thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockImplementation(() => [model]);
		let resolveRefresh!: (result: ModelsRefreshResult) => void;
		const refresh = new Promise<ModelsRefreshResult>((resolve) => {
			resolveRefresh = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "refresh").mockReturnValue(refresh);
		const selected = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			model,
			harness.session.modelRuntime,
			[],
			selected,
			() => {},
			undefined,
			undefined,
			undefined,
			() => "high",
		);
		selector.handleInput("\x1b[Z");
		expect(stripAnsi(selector.render(140).join("\n"))).toContain("[xhigh]");
		selector.handleInput("\x1b[Z");
		expect(stripAnsi(selector.render(140).join("\n"))).toContain("[max]");
		model = { ...model, reasoning: false };
		resolveRefresh({ aborted: false, errors: new Map() });
		await vi.waitFor(() => expect(stripAnsi(selector.render(140).join("\n"))).toContain("not supported"));
		selector.handleInput("\r");
		expect(selected).toHaveBeenCalledWith(model, "off");
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});
