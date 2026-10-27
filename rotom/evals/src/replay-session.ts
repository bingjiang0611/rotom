// Replay session construction: same product surface as a real run, but in memory.
//
// A replay must load the arm's own product (extensions, guidelines, tool surface),
// otherwise both arms are the same bare Pi and the comparison means nothing. The
// session is built from the product runtime the eval harness already verifies, and
// the only addition is a blocker extension that refuses every tool call.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadProductRuntime, type ProductRuntimeSelection } from "./product-runtime.ts";

export const REPLAY_TOOL_BLOCK_REASON = "replay: tools are not executed";

export type ReplayProduct = {
	/** Absolute path of the product build this arm loads. */
	productDir: string;
	selection: ProductRuntimeSelection;
	/** Stable digest of the loaded surface, so two arms can be told apart. */
	digest: string;
	extensions: string[];
	skills: string[];
	prompts: string[];
};

function resourcePaths(selection: ProductRuntimeSelection) {
	const paths = { extensions: [] as string[], skills: [] as string[], prompts: [] as string[] };
	for (const resource of selection.selectedResources) {
		const path = resolve(selection.agentDir, resource.loadPath ?? resource.path);
		if (resource.kind === "extension") paths.extensions.push(path);
		else if (resource.kind === "skill") paths.skills.push(path);
		else paths.prompts.push(path);
	}
	return paths;
}

/** Load one arm's product through the same verifier the eval harness uses. */
export async function loadReplayProduct({ productAgentDir, piExecutable, excludedResourceKeys }: { productAgentDir: string; piExecutable?: string; excludedResourceKeys?: readonly string[] }): Promise<ReplayProduct> {
	// Each arm must use its own product's Pi fork: falling back to a `pi` on PATH
	// would silently replay both arms on whatever Pi happens to be installed.
	const executable = piExecutable ?? process.env.ROTOM_PI?.trim() ?? (await bundledPi(productAgentDir));
	const selection = await loadProductRuntime({ agentDir: productAgentDir, piExecutable: executable, excludedResourceKeys });
	const paths = resourcePaths(selection);
	const digest = createHash("sha256")
		.update([selection.verified.version, ...paths.extensions, ...paths.skills, ...paths.prompts].join("\n"))
		.digest("hex");
	return { productDir: resolve(productAgentDir), selection, digest, ...paths };
}

async function bundledPi(productAgentDir: string): Promise<string> {
	const module = (await import(`${productAgentDir}/runtime/resolve-installed-pi.mjs`)) as { resolveInstalledPi: (agentDir: string) => Promise<string> };
	return module.resolveInstalledPi(productAgentDir);
}

/** The blocker writes this file when its factory runs; its absence fails the replay. */
export function blockerSource(markerPath: string) {
	return `import { appendFileSync } from "node:fs";
export default function(pi) {
	appendFileSync(${JSON.stringify(markerPath)}, "loaded\\n", { mode: 0o600 });
	pi.on("tool_call", () => ({ block: true, reason: ${JSON.stringify(REPLAY_TOOL_BLOCK_REASON)} }));
}
`;
}

/**
 * Build one throwaway session whose transcript ends before the replay point.
 * Everything is created per generation and removed afterwards: a generator is
 * reused across replay points, so nothing may survive between them.
 */
export async function openReplaySession({
	product, model, thinkingLevel, entries, scratch, extensions = [], cwd,
}: {
	product: ReplayProduct;
	model: { provider: string; id: string };
	thinkingLevel?: string;
	entries: readonly unknown[];
	scratch: string;
	extensions?: string[];
	cwd?: string;
}) {
	const workspace = cwd ?? join(scratch, "workspace");
	const configDir = join(scratch, "agent");
	const marker = join(scratch, "blocker.marker");
	const blocker = join(scratch, "block-tools.mjs");
	await mkdir(workspace, { recursive: true, mode: 0o700 });
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await writeFile(blocker, blockerSource(marker), { mode: 0o600 });

	const runtime = product.selection.runtime;
	const settingsManager = runtime.SettingsManager.create(workspace, configDir, { projectTrusted: false });
	const loader = new runtime.DefaultResourceLoader({
		cwd: workspace,
		agentDir: configDir,
		settingsManager,
		// Product extensions first, then the replay blocker and any test provider.
		additionalExtensionPaths: [...product.extensions, blocker, ...extensions],
		additionalSkillPaths: product.skills,
		additionalPromptTemplatePaths: product.prompts,
		noExtensions: true,
		noSkills: false,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const loadErrors = loader.getExtensions().errors;
	if (loadErrors.length > 0) throw new AggregateError(loadErrors.map((item) => item.error), "Replay extensions failed to load.");

	const modelRuntime = await runtime.ModelRuntime.create();
	const extensionRuntime = loader.getExtensions().runtime;
	for (const { name, config } of extensionRuntime.pendingProviderRegistrations) modelRuntime.registerProvider(name, config);
	for (const { provider } of extensionRuntime.pendingNativeProviderRegistrations) modelRuntime.registerNativeProvider(provider);
	extensionRuntime.pendingProviderRegistrations = [];
	extensionRuntime.pendingNativeProviderRegistrations = [];
	await modelRuntime.refresh({ allowNetwork: false });
	const selected = modelRuntime.getModel(model.provider, model.id);
	if (!selected) throw new Error(`Replay model not available: ${model.provider}/${model.id}`);

	// The installed runtime typings lag the fork (singleRequest, inMemory entries).
	const unstable = runtime as unknown as {
		SessionManager: { inMemory(cwd: string, options: object, entries: readonly unknown[]): never };
		createAgentSession(options: Record<string, unknown>): Promise<{ session: { bindExtensions(o: object): Promise<void>; dispose?(): void; agent: { subscribe(fn: (event: { type: string; message?: { role?: string } }) => void): () => void; continue(): Promise<void> } }; extensionsResult: { errors: { error: unknown }[] } }>;
	};
	const sessionManager = unstable.SessionManager.inMemory(workspace, {}, entries);
	const { session, extensionsResult } = await unstable.createAgentSession({
		cwd: workspace, agentDir: configDir, modelRuntime, model: selected,
		thinkingLevel: (thinkingLevel ?? "off") as never,
		resourceLoader: loader, sessionManager, settingsManager, singleRequest: true,
	});
	if (extensionsResult.errors.length > 0) throw new AggregateError(extensionsResult.errors.map((item) => item.error), "Replay extension binding failed.");
	await session.bindExtensions({ mode: "print", onError: (error: unknown) => { throw error; } });

	// Fail closed: without proof that the blocker loaded, a tool call could run.
	let markerSeen: string;
	try { markerSeen = await readFile(marker, "utf8"); }
	catch { await session.dispose?.(); throw new Error("Replay tool blocker did not load; refusing to generate."); }
	if (!markerSeen.includes("loaded")) { await session.dispose?.(); throw new Error("Replay tool blocker did not register; refusing to generate."); }

	return {
		workspace,
		blockerMarker: marker,
		async run(): Promise<{ message: unknown; elapsedMs: number }> {
			const started = Date.now();
			let captured: unknown;
			const unsubscribe = session.agent.subscribe((event: { type: string; message?: { role?: string } }) => {
				if (event.type === "message_end" && event.message?.role === "assistant") captured ??= event.message;
			});
			try {
				await session.agent.continue();
				for (let tick = 0; tick < 900 && !captured; tick += 1) await new Promise((resolveTick) => setTimeout(resolveTick, 100));
			} finally {
				unsubscribe?.();
			}
			if (!captured) throw new Error("the product produced no assistant message");
			return { message: captured, elapsedMs: Date.now() - started };
		},
		async close() { await session.dispose?.(); },
	};
}

/** Remove one generation's scratch tree; never called for another generation. */
export async function removeScratch(path: string) { await rm(path, { recursive: true, force: true }); }
