import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentSession, CreateAgentSessionOptions, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	type Harness,
	type HarnessContext,
	type JsonValue,
	normalizeRecord,
	type SimpleHarnessResult,
	type TranscriptEvent,
	toJsonValue,
} from "vitest-evals/harness";
import {
	captureEvalTraceSnapshot,
	PI_SESSION_SNAPSHOT_ARTIFACT,
	PI_TRACE_SNAPSHOT_ARTIFACT,
	PI_TRACE_SNAPSHOT_METADATA_ARTIFACT,
} from "./vitest-evals/artifacts.ts";
import {
	createProductRunManifest,
	defaultProductAgentDir,
	loadProductRuntime,
	type ProductRunManifest,
	type ProductRuntimeSelection,
	type WorkspaceFixtureDigestMode,
	productResourceKey,
} from "./product-runtime.ts";

export const DEV_AGENT_RUN_MANIFEST_ARTIFACT = "devAgentRunManifest";

export type PiCodingAgentStep = { type: "prompt"; content: string } | { type: "reload" };
export type PiCodingAgentScenario = {
	id: string;
	steps: PiCodingAgentStep[];
	metadata?: JsonValue;
};
export type PiCodingAgentInput = string | PiCodingAgentStep[] | PiCodingAgentScenario;

export type PiCodingAgentModelSelection = {
	provider: string;
	id: string;
};

export type PiEvalWorkspaceContext = {
	input: PiCodingAgentInput;
	workspace: string;
	configDir: string;
	sessionsDir: string;
};

export type PiCodingAgentOutputContext = PiEvalWorkspaceContext & {
	response: string;
	session: AgentSession;
	manifest: ProductRunManifest;
};

export type PiCodingAgentHarnessOptions = {
	name?: string;
	model?: PiCodingAgentModelSelection;
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	tools?: string[];
	noTools?: CreateAgentSessionOptions["noTools"];
	excludeTools?: string[];
	allowHostSideEffects?: boolean;
	productAgentDir?: string;
	piExecutable?: string;
	excludedResourceKeys?: string[];
	transformSystemPrompt?: (defaultPrompt: string) => string;
	/**
	 * Eval-side inline extensions, loaded alongside the product's own.
	 *
	 * Prefer this over `transformSystemPrompt` when reconstructing behaviour a
	 * product extension normally provides. `transformSystemPrompt` goes through
	 * the loader's `systemPromptOverride`, which replaces the *base* prompt, so
	 * appending an already-composed prompt there makes Pi emit the skill
	 * catalogue and cwd footer twice. A `before_agent_start` hook appends to the
	 * fully composed per-turn prompt instead, which is what product extensions
	 * do, so an arm built this way is positionally faithful to the real path.
	 */
	inlineExtensions?: InlineExtension[];
	setupWorkspace?: (context: PiEvalWorkspaceContext) => void | Promise<void>;
	modelRuntimeFactory?: (context: {
		product: ProductRuntimeSelection;
		configDir: string;
	}) => Promise<Awaited<ReturnType<typeof import("@earendil-works/pi-coding-agent").ModelRuntime.create>>>;
	environment?: Record<string, string | undefined>;
	environmentProfile?: string;
	workspaceFixtureDigestMode?: WorkspaceFixtureDigestMode;
	noContextFiles?: boolean;
	awaitCustomMessage?: {
		customType: string;
		timeoutMs?: number;
	};
};

type PiCodingAgentHarnessWithOutput<TOutput extends JsonValue> = PiCodingAgentHarnessOptions & {
	output: (context: PiCodingAgentOutputContext) => TOutput | Promise<TOutput>;
};

type EvalToolSelection = Pick<CreateAgentSessionOptions, "tools" | "noTools" | "excludeTools">;

export function resolveEvalToolSelection(
	options: Pick<PiCodingAgentHarnessOptions, "tools" | "noTools" | "excludeTools" | "allowHostSideEffects">,
	executionKind = process.env.ROTOM_EVAL_EXECUTION_KIND?.trim() || "host",
	environment = process.env,
): EvalToolSelection {
	const requested = { tools: options.tools, noTools: options.noTools, excludeTools: options.excludeTools };
	const hostSideEffectsAllowed = options.allowHostSideEffects ?? environment.ROTOM_EVAL_ALLOW_HOST_SIDE_EFFECTS === "1";
	if (executionKind !== "host" || hostSideEffectsAllowed || options.tools !== undefined || options.noTools !== undefined) return requested;
	if (options.excludeTools !== undefined) {
		throw new Error("Host evals require an explicit tools allowlist or allowHostSideEffects=true before exposing the product tool surface.");
	}
	return { ...requested, noTools: "all" };
}

let environmentQueue: Promise<void> = Promise.resolve();

async function withExclusiveEnvironment<T>(
	overrides: Readonly<Record<string, string | undefined>>,
	run: () => Promise<T>,
): Promise<T> {
	let release = () => {};
	const previous = environmentQueue;
	environmentQueue = new Promise<void>((resolveQueue) => {
		release = resolveQueue;
	});
	await previous;
	const original = new Map<string, string | undefined>();
	try {
		for (const [name, value] of Object.entries(overrides)) {
			original.set(name, process.env[name]);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		return await run();
	} finally {
		for (const [name, value] of original) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		release();
	}
}

export function resolveModelSelection(
	explicitModel: PiCodingAgentModelSelection | undefined,
	environment: { ROTOM_EVAL_PROVIDER?: string; ROTOM_EVAL_MODEL?: string } = process.env,
): PiCodingAgentModelSelection {
	const provider = (explicitModel?.provider ?? environment.ROTOM_EVAL_PROVIDER)?.trim();
	const id = (explicitModel?.id ?? environment.ROTOM_EVAL_MODEL)?.trim();
	if (!provider || !id) {
		throw new Error(
			"Select a harness model explicitly or set ROTOM_EVAL_PROVIDER and ROTOM_EVAL_MODEL.",
		);
	}
	return { provider, id };
}

function modelBaseOrigin(baseUrl: unknown): string | undefined {
	if (typeof baseUrl !== "string" || !baseUrl) return undefined;
	try {
		return new URL(baseUrl).origin;
	} catch {
		return undefined;
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const candidate = part as Record<string, unknown>;
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.join("");
}

export function toTranscriptEvents(messages: AgentSession["messages"]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: contentText(message.content) });
		} else if (message.role === "assistant") {
			const text = contentText(message.content);
			if (text) events.push({ type: "message", role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type === "toolCall") {
					events.push({
						type: "tool_call",
						id: part.id,
						name: part.name,
						arguments: normalizeRecord(part.arguments),
					});
				}
			}
		} else if (message.role === "custom") {
			const details = toJsonValue(message.details);
			events.push({
				type: "message",
				role: "user",
				content: contentText(message.content),
				metadata: {
					customType: message.customType,
					display: message.display,
					...(details === undefined ? {} : { details }),
				},
			});
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			events.push({
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content: message.content.every((part) => part.type === "text") ? text : toJsonValue(message.content),
				...(message.isError ? { error: { message: text || "Tool failed" } } : {}),
			});
		}
	}
	return events;
}

function normalizeSteps(input: PiCodingAgentInput): PiCodingAgentStep[] {
	if (typeof input === "string") return [{ type: "prompt", content: input }];
	return Array.isArray(input) ? input : input.steps;
}

export function latestAssistantResponse(session: AgentSession, previousMessageCount: number, allowEmpty = false): string {
	const assistant = session.messages
		.slice(previousMessageCount)
		.reverse()
		.find((message) => message.role === "assistant");
	if (!assistant) throw new Error("Agent run completed without an assistant message.");
	if (assistant.stopReason !== "stop") {
		throw new Error(assistant.errorMessage ?? `Agent run ended with unexpected stop reason: ${assistant.stopReason}.`);
	}
	const output = contentText(assistant.content);
	if (!output && !allowEmpty) throw new Error("Agent run produced no assistant text.");
	return output;
}

function createCustomMessageWaiter(session: AgentSession, customType: string) {
	let received = false;
	let notify: (() => void) | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "custom" || event.message.customType !== customType) return;
		received = true;
		notify?.();
	});
	return {
		async wait(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
			if (received) return;
			await new Promise<void>((resolveWait, rejectWait) => {
				const cleanup = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					notify = undefined;
				};
				const onAbort = () => {
					cleanup();
					rejectWait(signal?.reason ?? new Error("Eval custom-message wait aborted."));
				};
				const timer = setTimeout(() => {
					cleanup();
					rejectWait(new Error(`Timed out waiting for custom message ${customType} after ${String(timeoutMs)}ms.`));
				}, timeoutMs);
				notify = () => {
					cleanup();
					resolveWait();
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
		cancel(): void {
			unsubscribe();
			notify = undefined;
		},
	};
}

async function promptAgent(session: AgentSession, input: string, signal: AbortSignal | undefined, allowEmpty = false): Promise<string> {
	signal?.throwIfAborted();
	const previousMessageCount = session.messages.length;
	await session.prompt(input);
	await session.waitForIdle();
	return latestAssistantResponse(session, previousMessageCount, allowEmpty);
}

function resourcePaths(selection: Awaited<ReturnType<typeof loadProductRuntime>>) {
	const paths = { extensions: [] as string[], skills: [] as string[], prompts: [] as string[] };
	for (const resource of selection.selectedResources) {
		const path = resolve(selection.agentDir, resource.loadPath ?? resource.path);
		if (resource.kind === "extension") paths.extensions.push(path);
		else if (resource.kind === "skill") paths.skills.push(path);
		else paths.prompts.push(path);
	}
	return paths;
}

async function runPiCodingAgent<TOutput extends JsonValue>(
	input: PiCodingAgentInput,
	signal: AbortSignal | undefined,
	setArtifact: HarnessContext["setArtifact"],
	options: PiCodingAgentHarnessOptions | PiCodingAgentHarnessWithOutput<TOutput>,
): Promise<SimpleHarnessResult<string | TOutput>> {
	return withExclusiveEnvironment(options.environment ?? {}, async () => {
		const startedAt = performance.now();
		signal?.throwIfAborted();
		const selection = resolveModelSelection(options.model);
		const product = await loadProductRuntime({
			agentDir: options.productAgentDir ?? defaultProductAgentDir(),
			piExecutable: options.piExecutable,
			excludedResourceKeys: options.excludedResourceKeys,
		});
		const paths = resourcePaths(product);
		const runtime = product.runtime;

		const root = await mkdtemp(join(tmpdir(), "dev-agent-eval-"));
		const workspace = join(root, "workspace");
		const configDir = join(root, "agent");
		const sessionsDir = join(root, "sessions");
		let transformedSystemPrompt: string | undefined;
		let sessionManager: ReturnType<(typeof runtime.SessionManager)["create"]> | undefined;
		let session: AgentSession | undefined;
		let outcome:
			| { success: true; result: SimpleHarnessResult<string | TOutput> }
			| { success: false; error: unknown };
		try {
			await Promise.all([mkdir(workspace), mkdir(configDir), mkdir(sessionsDir)]);
			const workspaceContext = { input, workspace, configDir, sessionsDir };
			await options.setupWorkspace?.(workspaceContext);
			const modelRuntime = options.modelRuntimeFactory
				? await options.modelRuntimeFactory({ product, configDir })
				: await runtime.ModelRuntime.create();
			const model = modelRuntime.getModel(selection.provider, selection.id);
			if (!model) throw new Error(`Eval model not found: ${selection.provider}/${selection.id}`);
			const thinkingLevel = options.thinkingLevel ?? "off";
			const baseOrigin = modelBaseOrigin(model.baseUrl);
			const manifest = await createProductRunManifest({
				selection: product,
				workspace,
				model: {
					...selection,
					...(typeof model.api === "string" ? { api: model.api } : {}),
					...(baseOrigin ? { baseOrigin } : {}),
				},
				thinkingLevel,
				environmentProfile:
					options.environmentProfile ??
					(process.env.ROTOM_EVAL_ENVIRONMENT_PROFILE?.trim() || "isolated-local"),
				workspaceFixtureDigestMode: options.workspaceFixtureDigestMode,
			});
			const manifestArtifact = toJsonValue(manifest);
			if (manifestArtifact === undefined) throw new TypeError("Run manifest is not JSON-serializable.");
			setArtifact(DEV_AGENT_RUN_MANIFEST_ARTIFACT, manifestArtifact);

			const settingsManager = runtime.SettingsManager.create(workspace, configDir, { projectTrusted: false });
			const loader = new runtime.DefaultResourceLoader({
				cwd: workspace,
				agentDir: configDir,
				settingsManager,
				additionalExtensionPaths: paths.extensions,
				...(options.inlineExtensions ? { extensionFactories: options.inlineExtensions } : {}),
				additionalSkillPaths: paths.skills,
				additionalPromptTemplatePaths: paths.prompts,
				noExtensions: true,
				noSkills: false,
				noPromptTemplates: false,
				noThemes: true,
				noContextFiles: options.noContextFiles ?? true,
				...(options.transformSystemPrompt
					? { systemPromptOverride: (base: string | undefined) => transformedSystemPrompt ?? base }
					: {}),
			});
			await loader.reload();
			const extensionLoadErrors = loader.getExtensions().errors;
			if (extensionLoadErrors.length > 0) {
				throw new AggregateError(extensionLoadErrors.map((item) => item.error), "Product extensions failed to load.");
			}

			sessionManager = runtime.SessionManager.create(workspace, sessionsDir);
			setArtifact("runId", sessionManager.getSessionId());
			const toolSelection = resolveEvalToolSelection(options);
			const created = await runtime.createAgentSession({
				cwd: workspace,
				agentDir: configDir,
				modelRuntime,
				model,
				thinkingLevel,
				tools: toolSelection.tools,
				noTools: toolSelection.noTools,
				excludeTools: toolSelection.excludeTools,
				resourceLoader: loader,
				sessionManager,
				settingsManager,
				sessionStartEvent: { type: "session_start", reason: "startup" },
			});
			session = created.session;
			const lifecycleErrors: unknown[] = [];
			await session.bindExtensions({
				mode: "print",
				onError: (error) => lifecycleErrors.push(error),
			});
			if (created.extensionsResult.errors.length > 0) {
				throw new AggregateError(
					created.extensionsResult.errors.map((item) => item.error),
					"Agent session extensions failed to bind.",
				);
			}
			if (lifecycleErrors.length > 0) throw new AggregateError(lifecycleErrors, "Extension lifecycle failed.");

			if (options.transformSystemPrompt) {
				transformedSystemPrompt = options.transformSystemPrompt(session.systemPrompt);
				if (!transformedSystemPrompt.trim()) throw new Error("Transformed eval system prompt must not be empty.");
				await session.reload();
			}

			const evalSession = session;
			const scenarioStartMessageCount = evalSession.messages.length;
			const customMessageWaiter = options.awaitCustomMessage
				? createCustomMessageWaiter(evalSession, options.awaitCustomMessage.customType)
				: undefined;
			let abortPromise: Promise<void> | undefined;
			const abort = () => {
				abortPromise ??= evalSession.abort();
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				signal?.throwIfAborted();
				const steps = normalizeSteps(input);
				let response: string | undefined;
				for (const step of steps) {
					if (step.type === "prompt") response = await promptAgent(evalSession, step.content, signal, customMessageWaiter !== undefined);
					else await evalSession.reload();
				}
				if (customMessageWaiter && options.awaitCustomMessage) {
					await customMessageWaiter.wait(options.awaitCustomMessage.timeoutMs ?? 60_000, signal);
					await evalSession.waitForIdle();
					response = latestAssistantResponse(evalSession, scenarioStartMessageCount);
				}
				if (response === undefined) throw new Error("Pi eval input must include at least one prompt step.");
				if (lifecycleErrors.length > 0) throw new AggregateError(lifecycleErrors, "Extension lifecycle failed.");
				const output =
					"output" in options
						? await options.output({ ...workspaceContext, response, session: evalSession, manifest })
						: response;
				const stats = evalSession.getSessionStats();
				const hasPricing = [model.cost, ...(model.cost.tiers ?? [])].some(
					({ input, output, cacheRead, cacheWrite }) =>
						input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0,
				);
				outcome = {
					success: true,
					result: {
						output,
						events: toTranscriptEvents(evalSession.messages),
						usage: {
							provider: model.provider,
							model: model.id,
							inputTokens: stats.tokens.input,
							outputTokens: stats.tokens.output,
							totalTokens: stats.tokens.total,
							toolCalls: stats.toolCalls,
							metadata: {
								cacheReadTokens: stats.tokens.cacheRead,
								cacheWriteTokens: stats.tokens.cacheWrite,
								...(hasPricing ? { estimatedCostUsd: stats.cost } : {}),
							},
						},
					},
				};
			} finally {
				customMessageWaiter?.cancel();
				signal?.removeEventListener("abort", abort);
				if (abortPromise) await abortPromise;
			}
		} catch (error) {
			outcome = { success: false, error };
		}

		const cleanupErrors: unknown[] = [];
		if (session) {
			try {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} catch (error) {
				cleanupErrors.push(error);
			}
			try {
				session.dispose();
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (sessionManager) {
			try {
				const sessionPath = sessionManager.getSessionFile();
				if (sessionPath && existsSync(sessionPath)) {
					setArtifact(PI_SESSION_SNAPSHOT_ARTIFACT, await readFile(sessionPath, "utf8"));
					const trace = await captureEvalTraceSnapshot(sessionPath);
					if (trace) {
						setArtifact(PI_TRACE_SNAPSHOT_ARTIFACT, trace.body);
						setArtifact(PI_TRACE_SNAPSHOT_METADATA_ARTIFACT, trace.metadata);
					}
				}
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		try {
			await rm(root, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}

		if (!outcome.success) {
			if (cleanupErrors.length === 0) throw outcome.error;
			throw new AggregateError([outcome.error, ...cleanupErrors], "Agent run failed and cleanup also failed.");
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Agent cleanup failed.");
		return { ...outcome.result, timings: { totalMs: performance.now() - startedAt } };
	});
}

export function createPiCodingAgentHarness<TOutput extends JsonValue>(
	options: PiCodingAgentHarnessWithOutput<TOutput>,
): Harness<PiCodingAgentInput, TOutput>;
export function createPiCodingAgentHarness(
	options?: PiCodingAgentHarnessOptions,
): Harness<PiCodingAgentInput, string>;
export function createPiCodingAgentHarness<TOutput extends JsonValue>(
	options: PiCodingAgentHarnessOptions | PiCodingAgentHarnessWithOutput<TOutput> = {},
) {
	return createHarness<PiCodingAgentInput, string | TOutput>({
		name: options.name ?? "dev-agent",
		run: ({ input, signal, setArtifact }) => runPiCodingAgent(input, signal, setArtifact, options),
	});
}

export function describeSelectedResources(manifest: ProductRunManifest): string[] {
	return manifest.product.resources.map(({ key }) => key);
}

export function resourceKey(kind: "extension" | "skill" | "prompt", id: string): string {
	return productResourceKey({ kind, id });
}
