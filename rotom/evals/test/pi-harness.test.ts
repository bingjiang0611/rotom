import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { HarnessContext } from "vitest-evals/harness";
import {
	createPiCodingAgentHarness,
	DEV_AGENT_RUN_MANIFEST_ARTIFACT,
	describeSelectedResources,
	latestAssistantResponse,
	resolveEvalToolSelection,
	resolveModelSelection,
	resourceKey,
	toTranscriptEvents,
} from "../src/pi-harness.ts";
import {
	EVAL_TRACE_SNAPSHOT_SCHEMA_V1,
	PI_SESSION_SNAPSHOT_ARTIFACT,
	PI_TRACE_SNAPSHOT_ARTIFACT,
	PI_TRACE_SNAPSHOT_METADATA_ARTIFACT,
} from "../src/vitest-evals/artifacts.ts";
import type { ProductRunManifest } from "../src/product-runtime.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model over environment defaults", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ ROTOM_EVAL_PROVIDER: "openai", ROTOM_EVAL_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed eval-specific environment defaults", () => {
		expect(
			resolveModelSelection(undefined, {
				ROTOM_EVAL_PROVIDER: " openai ",
				ROTOM_EVAL_MODEL: " gpt-5.6-sol ",
			}),
		).toEqual({ provider: "openai", id: "gpt-5.6-sol" });
	});

	it.each([
		[undefined, {}],
		[undefined, { ROTOM_EVAL_PROVIDER: "openai" }],
		[undefined, { ROTOM_EVAL_MODEL: "gpt-5.6-sol" }],
	] as const)("rejects an incomplete model selection", (explicitModel, environment) => {
		expect(() => resolveModelSelection(explicitModel, environment)).toThrow("ROTOM_EVAL_PROVIDER");
	});
});

it("creates a named harness without evaluating a model", () => {
	expect(createPiCodingAgentHarness({ name: "candidate" }).name).toBe("candidate");
	expect(resourceKey("skill", "pi-subagents")).toBe("skill:pi-subagents");
});

it("disables the broad product tool surface for host evals unless access is explicit", () => {
	expect(resolveEvalToolSelection({}, "host", {})).toEqual({ tools: undefined, noTools: "all", excludeTools: undefined });
	expect(resolveEvalToolSelection({ tools: ["read"] }, "host", {})).toEqual({ tools: ["read"], noTools: undefined, excludeTools: undefined });
	expect(resolveEvalToolSelection({ allowHostSideEffects: true }, "host", {})).toEqual({ tools: undefined, noTools: undefined, excludeTools: undefined });
	expect(resolveEvalToolSelection({}, "host", { ROTOM_EVAL_ALLOW_HOST_SIDE_EFFECTS: "1" })).toEqual({ tools: undefined, noTools: undefined, excludeTools: undefined });
	expect(resolveEvalToolSelection({}, "apple-container", {})).toEqual({ tools: undefined, noTools: undefined, excludeTools: undefined });
	expect(() => resolveEvalToolSelection({ excludeTools: ["write"] }, "host", {})).toThrow("explicit tools allowlist");
});

it("allows an empty interim assistant acknowledgement only while waiting for a custom completion message", () => {
	const session = { messages: [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" }] } as unknown as AgentSession;
	expect(() => latestAssistantResponse(session, 0)).toThrow("no assistant text");
	expect(latestAssistantResponse(session, 0, true)).toBe("");
});

it("normalizes user, assistant, tool-call and tool-result messages", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "inspect" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "checking" },
				{ type: "toolCall", id: "call-1", name: "browser_inspect", arguments: { operation: "snapshot" } },
			],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "browser_inspect",
			content: [{ type: "text", text: "done" }],
			isError: false,
		},
		{
			role: "custom",
			customType: "custom-progress-notification",
			content: "failed",
			display: true,
			details: { status: "failed", id: "event-1" },
		},
	] as unknown as AgentSession["messages"];

	expect(toTranscriptEvents(messages)).toEqual([
		{ type: "message", role: "user", content: "inspect" },
		{ type: "message", role: "assistant", content: "checking" },
		{ type: "tool_call", id: "call-1", name: "browser_inspect", arguments: { operation: "snapshot" } },
		{ type: "tool_result", toolCallId: "call-1", name: "browser_inspect", content: "done" },
		{
			type: "message",
			role: "user",
			content: "failed",
			metadata: {
				customType: "custom-progress-notification",
				display: true,
				details: { status: "failed", id: "event-1" },
			},
		},
	]);
});

it("projects selected resource keys from the run manifest", () => {
	const manifest = {
		product: { resources: [{ key: "extension:browser" }, { key: "skill:pi-subagents" }] },
	} as ProductRunManifest;
	expect(describeSelectedResources(manifest)).toEqual(["extension:browser", "skill:pi-subagents"]);
});

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

it("runs a real product AgentSession with an injected faux model and captures artifacts", async () => {
	const harness = createPiCodingAgentHarness({
		name: "faux-product-smoke",
		model: { provider: "dev-agent-eval-faux", id: "fixture" },
		piExecutable: process.env.ROTOM_TEST_PI,
		tools: [],
		async modelRuntimeFactory({ product, configDir }) {
			const piAiEntry = await findPiAiEntry(product.verified.packageRoot);
			const { fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(piAiEntry).href);
			const faux = fauxProvider({
				provider: "dev-agent-eval-faux",
				models: [{ id: "fixture", contextWindow: 12_000, maxTokens: 1_024 }],
			});
			faux.setResponses([fauxAssistantMessage("faux-ready")]);
			const modelRuntime = await product.runtime.ModelRuntime.create({
				authPath: resolve(configDir, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerNativeProvider(faux.provider);
			return modelRuntime;
		},
	});
	const artifacts: HarnessContext["artifacts"] = {};
	const context: HarnessContext = {
		artifacts,
		setArtifact(name, value) {
			artifacts[name] = value;
		},
	};
	const result = await harness.run("Reply with the fixture response.", context);

	expect(result.output).toBe("faux-ready");
	expect(result.session.events).toContainEqual({ type: "message", role: "assistant", content: "faux-ready" });
	expect(result.artifacts?.[DEV_AGENT_RUN_MANIFEST_ARTIFACT]).toEqual(
		expect.objectContaining({
			schemaVersion: 1,
			environmentProfile: process.env.ROTOM_EVAL_ENVIRONMENT_PROFILE ?? "isolated-local",
			execution: expect.objectContaining({ kind: process.env.ROTOM_EVAL_EXECUTION_KIND ?? "host" }),
		}),
	);
	expect(result.artifacts?.[PI_SESSION_SNAPSHOT_ARTIFACT]).toEqual(expect.stringContaining("faux-ready"));
	expect(result.artifacts?.[PI_TRACE_SNAPSHOT_ARTIFACT]).toEqual(expect.stringContaining('"pi.session.shutdown_reason":"quit"'));
	expect(result.artifacts?.[PI_TRACE_SNAPSHOT_METADATA_ARTIFACT]).toEqual({
		schema: EVAL_TRACE_SNAPSHOT_SCHEMA_V1,
		originalBytes: expect.any(Number),
		capturedBytes: expect.any(Number),
		truncated: false,
		strategy: "full",
	});
});

it("retains post-shutdown session and trace artifacts when deterministic output projection fails", async () => {
	const harness = createPiCodingAgentHarness({
		name: "faux-product-failure",
		model: { provider: "dev-agent-eval-faux", id: "fixture" },
		piExecutable: process.env.ROTOM_TEST_PI,
		tools: [],
		async modelRuntimeFactory({ product, configDir }) {
			const piAiEntry = await findPiAiEntry(product.verified.packageRoot);
			const { fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(piAiEntry).href);
			const faux = fauxProvider({
				provider: "dev-agent-eval-faux",
				models: [{ id: "fixture", contextWindow: 12_000, maxTokens: 1_024 }],
			});
			faux.setResponses([fauxAssistantMessage("faux-before-output-error")]);
			const modelRuntime = await product.runtime.ModelRuntime.create({
				authPath: resolve(configDir, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerNativeProvider(faux.provider);
			return modelRuntime;
		},
		output() {
			throw new Error("deterministic projection failed");
		},
	});
	const artifacts: HarnessContext["artifacts"] = {};
	const context: HarnessContext = {
		artifacts,
		setArtifact(name, value) { artifacts[name] = value; },
	};
	await expect(harness.run("Reach output projection.", context)).rejects.toThrow("deterministic projection failed");
	expect(artifacts[PI_SESSION_SNAPSHOT_ARTIFACT]).toEqual(expect.stringContaining("faux-before-output-error"));
	expect(artifacts[PI_TRACE_SNAPSHOT_ARTIFACT]).toEqual(expect.stringContaining('"pi.session.shutdown_reason":"quit"'));
	expect(artifacts[PI_TRACE_SNAPSHOT_METADATA_ARTIFACT]).toEqual(expect.objectContaining({
		schema: EVAL_TRACE_SNAPSHOT_SCHEMA_V1,
		truncated: false,
		strategy: "full",
	}));
});
