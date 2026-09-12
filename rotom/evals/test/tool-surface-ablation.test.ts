import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { HarnessContext } from "vitest-evals/harness";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";

const { measureContextFootprint } = await import(
	pathToFileURL(resolve(import.meta.dirname, "../../runtime/context-footprint.mjs")).href
) as { measureContextFootprint: (input: Record<string, unknown>) => any };

const MANAGED_CDP_TOOLS = ["launch_browser", "navigate_browser", "evaluate_browser"];

async function findPiAiEntry(packageRoot: string): Promise<string> {
	let directory = packageRoot;
	for (;;) {
		const candidate = resolve(directory, "node_modules/@earendil-works/pi-ai/dist/index.js");
		if (await access(candidate).then(() => true, () => false)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`Cannot resolve pi-ai from ${packageRoot}`);
		directory = parent;
	}
}

type ToolSurfaceOptions = {
	tools?: string[];
	excludeTools?: string[];
	environment?: Record<string, string | undefined>;
};

function createToolSurfaceHarness(name: string, options: ToolSurfaceOptions = {}) {
	return createPiCodingAgentHarness({
		name,
		model: { provider: "dev-agent-tool-ablation-faux", id: "fixture" },
		piExecutable: process.env.ROTOM_TEST_PI,
		allowHostSideEffects: true,
		tools: options.tools,
		excludeTools: options.excludeTools,
		environment: options.environment ?? {
			ROTOM_DEFERRED_TOOLS: "0",
			ROTOM_EXPERIMENTAL_DEFERRED_TOOLS: undefined,
		},
		noContextFiles: true,
		async modelRuntimeFactory({ product, configDir }) {
			const piAiEntry = await findPiAiEntry(product.verified.packageRoot);
			const { fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(piAiEntry).href);
			const faux = fauxProvider({
				provider: "dev-agent-tool-ablation-faux",
				models: [{ id: "fixture", contextWindow: 12_000, maxTokens: 1_024 }],
			});
			faux.setResponses([fauxAssistantMessage("ablation-ready")]);
			const modelRuntime = await product.runtime.ModelRuntime.create({
				authPath: resolve(configDir, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerNativeProvider(faux.provider);
			return modelRuntime;
		},
		output({ session }) {
			const activeTools = session.getActiveToolNames();
			return {
				activeTools,
				footprint: measureContextFootprint({
					systemPrompt: session.systemPrompt,
					allTools: session.getAllTools(),
					activeToolNames: activeTools,
					contextFiles: [],
					skills: [],
				}),
			};
		},
	});
}

async function runHarness(harness: ReturnType<typeof createToolSurfaceHarness>) {
	const artifacts: HarnessContext["artifacts"] = {};
	return harness.run("Return the fixture response.", {
		artifacts,
		setArtifact(name, value) { artifacts[name] = value; },
	});
}

it("measures the managed-CDP ablation without removing relay or native desktop capabilities", async () => {
	const full = await runHarness(createToolSurfaceHarness("full-tool-surface"));
	const ablated = await runHarness(createToolSurfaceHarness("without-managed-cdp", { excludeTools: MANAGED_CDP_TOOLS }));
	const fullOutput = full.output as any;
	const ablatedOutput = ablated.output as any;

	for (const tool of ["browser_inspect", "browser_interact", "find_roots", "observe_ui", "act_ui"]) {
		expect(ablatedOutput.activeTools).toContain(tool);
	}
	for (const tool of MANAGED_CDP_TOOLS) {
		expect(fullOutput.activeTools).toContain(tool);
		expect(ablatedOutput.activeTools).not.toContain(tool);
	}
	expect(ablatedOutput.footprint.activeToolCount).toBe(fullOutput.footprint.activeToolCount - MANAGED_CDP_TOOLS.length);
	expect(fullOutput.footprint.activeToolSchemaBytes - ablatedOutput.footprint.activeToolSchemaBytes).toBe(917);
	expect(fullOutput.footprint.activeToolGuidelineBytes - ablatedOutput.footprint.activeToolGuidelineBytes).toBe(69);
});

it("preserves explicit tools and excludeTools selections when deferred loading defaults on", async () => {
	const defaultEnvironment = {
		ROTOM_DEFERRED_TOOLS: undefined,
		ROTOM_EXPERIMENTAL_DEFERRED_TOOLS: undefined,
	};
	const allowlisted = await runHarness(createToolSurfaceHarness("explicit-tools", {
		tools: ["read", "browser_inspect"],
		environment: defaultEnvironment,
	}));
	const excluded = await runHarness(createToolSurfaceHarness("explicit-exclude", {
		excludeTools: ["browser_inspect"],
		environment: defaultEnvironment,
	}));
	const allowlistedTools = (allowlisted.output as any).activeTools;
	const excludedTools = (excluded.output as any).activeTools;

	expect(new Set(allowlistedTools)).toEqual(new Set(["read", "browser_inspect"]));
	expect(excludedTools).not.toContain("browser_inspect");
	expect(excludedTools).toContain("browser_interact");
	expect(excludedTools).toContain("subagent");
	expect(excludedTools).toContain("search_tools");
});
