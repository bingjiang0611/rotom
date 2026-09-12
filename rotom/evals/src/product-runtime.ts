import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, opendir, readFile, readlink, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;
export type WorkspaceFixtureDigestMode = "full" | "working-tree";

export type ProductResourceKind = "extension" | "skill" | "prompt";

export type ProductResourceDescriptor = {
	id: string;
	kind: ProductResourceKind;
	path: string;
	loadPath?: string;
	requiredFiles: string[];
};

export type VerifiedPiRuntime = {
	executable: string;
	packageRoot: string;
	packagePath: string;
	publicEntry: string;
	version: string;
};

export type ProductRuntimeSelection = {
	agentDir: string;
	allResources: ProductResourceDescriptor[];
	selectedResources: ProductResourceDescriptor[];
	verified: VerifiedPiRuntime;
	runtime: typeof PiCodingAgent;
};

export type ProductGitIdentity = {
	gitHead?: string;
	gitDirty: boolean | "unknown";
	gitWorktreeDigest?: string;
};

export type ProductExecutionManifest =
	| { kind: "host"; platform: string }
	| {
			kind: "apple-container";
			platform: string;
			cliVersion: string;
			image: string;
			imageDigest: string;
			network: string;
			cpus: string;
			memory: string;
	  };

export type ProductRunManifest = {
	schemaVersion: 1;
	pi: {
		version: string;
		executable: string;
		packageRoot: string;
	};
	product: {
		agentDir: string;
		gitHead?: string;
		gitDirty: boolean | "unknown";
		gitWorktreeDigest?: string;
		resources: Array<{
			key: string;
			path: string;
			loadPath?: string;
			digest: string;
		}>;
	};
	model: {
		provider: string;
		id: string;
		api?: string;
		baseOrigin?: string;
		thinkingLevel: string;
	};
	environmentProfile: string;
	execution: ProductExecutionManifest;
	workspaceFixtureDigestMode: WorkspaceFixtureDigestMode;
	workspaceFixtureDigest: string;
};

type ProductConfigModule = { RESOURCE_DESCRIPTORS_V1?: unknown };
type RuntimeVerifierModule = {
	verifyPiRuntime?: (input: {
		executable: string;
		agentDir: string;
		resourceDeclarations: string[];
	}) => Promise<VerifiedPiRuntime>;
};

function assertDescriptor(value: unknown, index: number): asserts value is ProductResourceDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Product resource descriptor ${index} is not an object.`);
	}
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.id !== "string" ||
		!candidate.id ||
		(candidate.kind !== "extension" && candidate.kind !== "skill" && candidate.kind !== "prompt") ||
		typeof candidate.path !== "string" ||
		!candidate.path ||
		(candidate.loadPath !== undefined && typeof candidate.loadPath !== "string") ||
		!Array.isArray(candidate.requiredFiles) ||
		!candidate.requiredFiles.every((item) => typeof item === "string" && item.length > 0)
	) {
		throw new TypeError(`Product resource descriptor ${index} has an invalid shape.`);
	}
}

export function productResourceKey(resource: Pick<ProductResourceDescriptor, "kind" | "id">): string {
	return `${resource.kind}:${resource.id}`;
}

export function defaultProductAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
	const selected = environment.ROTOM_PRODUCT_AGENT_DIR?.trim();
	return selected ? resolve(selected) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

async function assertExecutable(candidate: string): Promise<string> {
	if (!isAbsolute(candidate)) throw new TypeError(`Pi executable must be absolute: ${candidate}`);
	await access(candidate, constants.X_OK).catch(() => {
		throw new Error(`Pi executable is missing or not executable: ${candidate}`);
	});
	const info = await lstat(candidate);
	if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Pi executable is not a file: ${candidate}`);
	return realpath(candidate);
}

export async function resolvePiExecutable(
	explicit = process.env.ROTOM_PI,
	environmentPath = process.env.PATH,
): Promise<string> {
	const selected = explicit?.trim();
	if (selected) return assertExecutable(selected);
	for (const directory of (environmentPath ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = resolve(directory, "pi");
		try {
			return await assertExecutable(candidate);
		} catch {
			// Continue through PATH. The authoritative verifier performs package identity checks later.
		}
	}
	throw new Error("Cannot find pi on PATH; set ROTOM_PI to an absolute executable path.");
}

export function selectProductResources(
	resources: readonly ProductResourceDescriptor[],
	excludedResourceKeys: readonly string[] = [],
): ProductResourceDescriptor[] {
	const excluded = new Set(excludedResourceKeys);
	return resources.filter((resource) => !excluded.has(productResourceKey(resource)));
}

export async function loadProductRuntime(input: {
	agentDir?: string;
	piExecutable?: string;
	excludedResourceKeys?: readonly string[];
} = {}): Promise<ProductRuntimeSelection> {
	const agentDir = resolve(input.agentDir ?? defaultProductAgentDir());
	const piExecutable = await resolvePiExecutable(input.piExecutable);
	const configUrl = pathToFileURL(resolve(agentDir, "runtime/product-config.mjs")).href;
	const verifierUrl = pathToFileURL(resolve(agentDir, "runtime/verify-pi-runtime.mjs")).href;
	const config = (await import(configUrl)) as ProductConfigModule;
	const descriptors = config.RESOURCE_DESCRIPTORS_V1;
	if (!Array.isArray(descriptors)) throw new TypeError("Product config does not export RESOURCE_DESCRIPTORS_V1.");
	descriptors.forEach(assertDescriptor);
	const allResources = descriptors.map((descriptor) => ({ ...descriptor, requiredFiles: [...descriptor.requiredFiles] }));
	const verifier = (await import(verifierUrl)) as RuntimeVerifierModule;
	if (typeof verifier.verifyPiRuntime !== "function") {
		throw new TypeError("Product runtime verifier does not export verifyPiRuntime.");
	}
	const resourceDeclarations = allResources.map(
		(resource) => `${resource.kind}:${resolve(agentDir, resource.path)}`,
	);
	const verified = await verifier.verifyPiRuntime({
		executable: piExecutable,
		agentDir,
		resourceDeclarations,
	});
	const runtime = (await import(pathToFileURL(verified.publicEntry).href)) as typeof PiCodingAgent;
	return {
		agentDir,
		allResources,
		selectedResources: selectProductResources(allResources, input.excludedResourceKeys),
		verified,
		runtime,
	};
}

function assertInside(root: string, candidate: string): void {
	const nested = relative(root, candidate);
	if (nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))) return;
	throw new Error(`Resource path escapes product root: ${candidate}`);
}

export async function digestProductResource(agentDir: string, resource: ProductResourceDescriptor): Promise<string> {
	const hash = createHash("sha256");
	hash.update(JSON.stringify({
		id: resource.id,
		kind: resource.kind,
		path: resource.path,
		loadPath: resource.loadPath ?? null,
		requiredFiles: resource.requiredFiles,
	}));
	const root = resolve(agentDir, resource.path);
	assertInside(agentDir, root);
	for (const requiredFile of [...resource.requiredFiles].sort()) {
		const file = resolve(root, requiredFile);
		assertInside(agentDir, file);
		hash.update(`\0${requiredFile}\0`);
		hash.update(await readFile(file));
	}
	return hash.digest("hex");
}

export async function snapshotProductGitIdentity(agentDir: string): Promise<ProductGitIdentity> {
	try {
		const { stdout: topLevelOutput } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
			cwd: agentDir,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		const root = topLevelOutput.trim();
		const productPath = relative(root, agentDir);
		const [{ stdout: head }, { stdout: status }, { stdout: diff }, { stdout: untrackedOutput }] = await Promise.all([
			execFileAsync("git", ["rev-parse", "HEAD"], { cwd: agentDir, encoding: "utf8", maxBuffer: 1024 * 1024 }),
			execFileAsync("git", ["status", "--porcelain=v1", "-z", "--", productPath], {
				cwd: root,
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
			}),
			execFileAsync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", productPath], {
				cwd: root,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
			}),
			execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", productPath], {
				cwd: root,
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
			}),
		]);
		const worktreeHash = createHash("sha256").update(diff);
		const untracked = untrackedOutput.split("\0").filter(Boolean).sort();
		for (const entry of untracked) {
			const file = resolve(root, entry);
			const info = await lstat(file);
			worktreeHash.update(`\0${entry}\0`);
			if (info.isFile()) worktreeHash.update(await readFile(file));
			else if (info.isSymbolicLink()) worktreeHash.update(await readlink(file));
			else worktreeHash.update(`mode:${info.mode}`);
		}
		return {
			gitHead: head.trim(),
			gitDirty: status.length > 0,
			gitWorktreeDigest: worktreeHash.digest("hex"),
		};
	} catch {
		return { gitDirty: "unknown" };
	}
}

function productGitIdentityFromEnvironment(environment: NodeJS.ProcessEnv): ProductGitIdentity | undefined {
	if (environment.ROTOM_EVAL_EXECUTION_KIND !== "apple-container") return undefined;
	const gitHead = environment.ROTOM_EVAL_PRODUCT_GIT_HEAD?.trim();
	const gitWorktreeDigest = environment.ROTOM_EVAL_PRODUCT_GIT_WORKTREE_DIGEST?.trim();
	const dirtyValue = environment.ROTOM_EVAL_PRODUCT_GIT_DIRTY?.trim();
	if (gitHead && !/^[a-f0-9]{40,64}$/u.test(gitHead)) throw new TypeError("Invalid product Git HEAD metadata.");
	if (gitWorktreeDigest && !/^[a-f0-9]{64}$/u.test(gitWorktreeDigest)) {
		throw new TypeError("Invalid product Git worktree digest metadata.");
	}
	if (dirtyValue !== "true" && dirtyValue !== "false" && dirtyValue !== "unknown") {
		throw new TypeError("Invalid product Git dirty metadata.");
	}
	return {
		...(gitHead ? { gitHead } : {}),
		gitDirty: dirtyValue === "true" ? true : dirtyValue === "false" ? false : "unknown",
		...(gitWorktreeDigest ? { gitWorktreeDigest } : {}),
	};
}

export function resolveExecutionManifest(
	environment: NodeJS.ProcessEnv = process.env,
	platform = process.platform,
	architecture = process.arch,
): ProductExecutionManifest {
	const kind = environment.ROTOM_EVAL_EXECUTION_KIND?.trim() || "host";
	const executionPlatform = `${platform}/${architecture}`;
	if (kind === "host") return { kind, platform: executionPlatform };
	if (kind !== "apple-container") throw new TypeError(`Unknown eval execution kind: ${kind}`);

	const cliVersion = environment.ROTOM_EVAL_CONTAINER_CLI_VERSION?.trim();
	const image = environment.ROTOM_EVAL_CONTAINER_IMAGE?.trim();
	const imageDigest = environment.ROTOM_EVAL_CONTAINER_IMAGE_DIGEST?.trim();
	const network = environment.ROTOM_EVAL_CONTAINER_NETWORK?.trim();
	const cpus = environment.ROTOM_EVAL_CONTAINER_CPUS?.trim();
	const memory = environment.ROTOM_EVAL_CONTAINER_MEMORY?.trim();
	if (!cliVersion || !image || !network || !cpus || !memory) {
		throw new TypeError("Apple container execution metadata is incomplete.");
	}
	if (!imageDigest || !/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) {
		throw new TypeError("Apple container image digest is invalid.");
	}
	return { kind, platform: executionPlatform, cliVersion, image, imageDigest, network, cpus, memory };
}

async function appendDirectory(
	hash: ReturnType<typeof createHash>,
	root: string,
	directory: string,
	budget: { bytes: number },
	mode: WorkspaceFixtureDigestMode,
) {
	const entries = [];
	for await (const entry of await opendir(directory)) entries.push(entry);
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const path = join(directory, entry.name);
		const relativePath = relative(root, path);
		const info = await lstat(path);
		if (mode === "working-tree" && entry.name === ".git") {
			hash.update(`vcs-omitted\0${relativePath}\0`);
			continue;
		}
		if (info.isDirectory()) {
			hash.update(`d\0${relativePath}\0`);
			await appendDirectory(hash, root, path, budget, mode);
		} else if (info.isFile()) {
			budget.bytes += info.size;
			if (budget.bytes > MAX_FIXTURE_BYTES) throw new Error("Eval workspace fixture exceeds 32 MiB.");
			hash.update(`f\0${relativePath}\0`);
			hash.update(await readFile(path));
		} else if (info.isSymbolicLink()) {
			hash.update(`l\0${relativePath}\0${await readlink(path)}\0`);
		} else {
			throw new Error(`Unsupported eval fixture entry: ${relativePath}`);
		}
	}
}

export async function digestWorkspaceFixture(workspace: string, mode: WorkspaceFixtureDigestMode = "full"): Promise<string> {
	const hash = createHash("sha256");
	await appendDirectory(hash, workspace, workspace, { bytes: 0 }, mode);
	return hash.digest("hex");
}

export async function createProductRunManifest(input: {
	selection: ProductRuntimeSelection;
	workspace: string;
	model: { provider: string; id: string; api?: string; baseOrigin?: string };
	thinkingLevel: string;
	environmentProfile: string;
	workspaceFixtureDigestMode?: WorkspaceFixtureDigestMode;
}): Promise<ProductRunManifest> {
	const { selection } = input;
	const resources = [];
	for (const resource of selection.selectedResources) {
		resources.push({
			key: productResourceKey(resource),
			path: resource.path,
			...(resource.loadPath ? { loadPath: resource.loadPath } : {}),
			digest: await digestProductResource(selection.agentDir, resource),
		});
	}
	const git = productGitIdentityFromEnvironment(process.env) ?? await snapshotProductGitIdentity(selection.agentDir);
	const workspaceFixtureDigestMode = input.workspaceFixtureDigestMode ?? "full";
	return {
		schemaVersion: 1,
		pi: {
			version: selection.verified.version,
			executable: selection.verified.executable,
			packageRoot: selection.verified.packageRoot,
		},
		product: {
			agentDir: selection.agentDir,
			...git,
			resources,
		},
		model: { ...input.model, thinkingLevel: input.thinkingLevel },
		environmentProfile: input.environmentProfile,
		execution: resolveExecutionManifest(),
		workspaceFixtureDigestMode,
		workspaceFixtureDigest: await digestWorkspaceFixture(input.workspace, workspaceFixtureDigestMode),
	};
}
