import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createProductRunManifest,
	defaultProductAgentDir,
	digestProductResource,
	digestWorkspaceFixture,
	loadProductRuntime,
	productResourceKey,
	resolveExecutionManifest,
	resolvePiExecutable,
	selectProductResources,
	type ProductResourceDescriptor,
} from "../src/product-runtime.ts";

const resources: ProductResourceDescriptor[] = [
	{ id: "browser", kind: "extension", path: "extensions/browser", requiredFiles: ["index.ts"] },
	{ id: "third-party", kind: "extension", path: "extensions/third-party", requiredFiles: ["index.ts"] },
	{ id: "pi-subagents", kind: "skill", path: "skills/pi-subagents", requiredFiles: ["SKILL.md"] },
];

describe("product resource selection", () => {
	it("uses stable kind/id keys and preserves all non-excluded resources", () => {
		expect(productResourceKey(resources[0])).toBe("extension:browser");
		expect(selectProductResources(resources).map(productResourceKey)).toEqual([
			"extension:browser",
			"extension:third-party",
			"skill:pi-subagents",
		]);
	});

	it("supports an explicit resource exclusion for treatment arms", () => {
		expect(selectProductResources(resources, ["skill:pi-subagents"]).map(productResourceKey)).toEqual([
			"extension:browser",
			"extension:third-party",
		]);
	});
});

it("uses an explicit mounted product path inside Apple container", () => {
	expect(defaultProductAgentDir({ ROTOM_PRODUCT_AGENT_DIR: "/workspace/product" })).toBe("/workspace/product");
});

describe("product-owned Pi resolution", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("ignores a shadow pi on PATH and selects the candidate's locked fork", async () => {
		const root = await mkdtemp(join(tmpdir(), "rotom-eval-pi-path-"));
		const agentDir = defaultProductAgentDir();
		try {
			await writeFile(join(root, "pi"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
			vi.stubEnv("PATH", root);
			vi.stubEnv("ROTOM_PI", undefined);
			vi.stubEnv("ROTOM_PRODUCT_AGENT_DIR", agentDir);
			const packageRoot = resolve(agentDir, "runtime/pi/node_modules/@earendil-works/pi-coding-agent");
			const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
			expect(await resolvePiExecutable()).toBe(await realpath(resolve(packageRoot, metadata.bin.pi)));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a candidate missing its installed fork instead of falling back to PATH", async () => {
		const root = await mkdtemp(join(tmpdir(), "rotom-eval-pi-missing-"));
		try {
			for (const path of [
				"package.json", "runtime/product-config.mjs", "runtime/verify-pi-runtime.mjs",
				"runtime/resolve-installed-pi.mjs", "runtime/pi/package.json",
				"runtime/pi/package-lock.json", "runtime/pi/fork-build.json",
			]) {
				const target = resolve(root, path);
				await mkdir(dirname(target), { recursive: true });
				await copyFile(resolve(defaultProductAgentDir(), path), target);
			}
			await writeFile(join(root, "pi"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
			vi.stubEnv("PATH", root);
			await expect(resolvePiExecutable("", root)).rejects.toThrow("缺少 rotom 随附的 Pi fork");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves explicit executable and ROTOM_PI overrides", async () => {
		const executable = await resolvePiExecutable("", defaultProductAgentDir());
		vi.stubEnv("ROTOM_PI", executable);
		expect(await resolvePiExecutable(undefined, "/missing-candidate")).toBe(executable);
		expect(await resolvePiExecutable(executable, "/missing-candidate")).toBe(executable);
	});

	it.each(["relative-pi", "/missing-rotom-pi/executable"])("rejects invalid explicit override %s without fallback", async (executable) => {
		await expect(resolvePiExecutable(executable)).rejects.toThrow(/absolute|missing or not executable/u);
	});
});

it("binds every required browser helper to the resource digest and fails when one is missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "dev-agent-browser-digest-test-"));
	const resource: ProductResourceDescriptor = { id: "browser", kind: "extension", path: "extensions/browser", requiredFiles: ["index.ts", "chrome-extension/full-read.js"] };
	try {
		await mkdir(resolve(root, resource.path, "chrome-extension"), { recursive: true });
		await writeFile(resolve(root, resource.path, "index.ts"), "export default 1;\n");
		await writeFile(resolve(root, resource.path, "chrome-extension/full-read.js"), "export const version = 1;\n");
		const first = await digestProductResource(root, resource);
		await writeFile(resolve(root, resource.path, "chrome-extension/full-read.js"), "export const version = 2;\n");
		expect(await digestProductResource(root, resource)).not.toBe(first);
		await rm(resolve(root, resource.path, "chrome-extension/full-read.js"));
		await expect(digestProductResource(root, resource)).rejects.toThrow();
		await expect(digestProductResource(root, { ...resource, requiredFiles: ["../../../outside.ts"] })).rejects.toThrow("escapes product root");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("records host and immutable Apple container execution identities", () => {
	expect(resolveExecutionManifest({}, "darwin", "arm64")).toEqual({
		kind: "host",
		platform: "darwin/arm64",
	});
	expect(
		resolveExecutionManifest(
			{
				ROTOM_EVAL_EXECUTION_KIND: "apple-container",
				ROTOM_EVAL_CONTAINER_CLI_VERSION: "container CLI version 1.2.2",
				ROTOM_EVAL_CONTAINER_IMAGE: "dev-agent-evals:local",
				ROTOM_EVAL_CONTAINER_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
				ROTOM_EVAL_CONTAINER_NETWORK: "default",
				ROTOM_EVAL_CONTAINER_CPUS: "4",
				ROTOM_EVAL_CONTAINER_MEMORY: "8G",
			},
			"linux",
			"arm64",
		),
	).toEqual({
		kind: "apple-container",
		platform: "linux/arm64",
		cliVersion: "container CLI version 1.2.2",
		image: "dev-agent-evals:local",
		imageDigest: `sha256:${"a".repeat(64)}`,
		network: "default",
		cpus: "4",
		memory: "8G",
	});
});

it("verifies and imports the actual product runtime without a compact-policy extension", async () => {
	const product = await loadProductRuntime({
		agentDir: defaultProductAgentDir(),
		piExecutable: process.env.ROTOM_TEST_PI,
	});

	expect(product.verified.version).toMatch(/^\d+\.\d+\.\d+/u);
	expect(product.runtime.VERSION).toBe(product.verified.version);
	expect(product.allResources.map(productResourceKey)).toEqual([
		"extension:observability", "extension:browser", "extension:coding-policy", "extension:context-layers", "extension:third-party", "extension:qoder",
		"skill:pi-subagents",
	]);
	expect(product.selectedResources.map(productResourceKey)).toContain("extension:browser");
	const browser = product.allResources.find((resource) => productResourceKey(resource) === "extension:browser");
	expect(browser?.requiredFiles).toEqual(expect.arrayContaining([
		"chrome-extension/full-read.js",
		"chrome-extension/interaction-scroll-target.js",
		"chrome-extension/relay-deadline.js",
		"chrome-extension/rendered-text.js",
		"chrome-extension/scoped-ax-ref.js",
	]));
});

it.skipIf(!process.env.ROTOM_TEST_SIDECAR)(
	"accepts the stock sidecar runtime without extension-only capabilities",
	async () => {
		const product = await loadProductRuntime({
			agentDir: defaultProductAgentDir(),
			piExecutable: process.env.ROTOM_TEST_SIDECAR,
		});
		expect(product.selectedResources.map(productResourceKey)).not.toContain("extension:compact-policy");
	},
);

it("creates a reproducible fixture digest and a resource-bound run manifest", async () => {
	const root = await mkdtemp(join(tmpdir(), "dev-agent-eval-manifest-test-"));
	try {
		await mkdir(resolve(root, "nested"));
		await writeFile(resolve(root, "nested/input.txt"), "fixture\n");
		const firstDigest = await digestWorkspaceFixture(root);
		const secondDigest = await digestWorkspaceFixture(root);
		expect(secondDigest).toBe(firstDigest);

		const product = await loadProductRuntime({
			agentDir: defaultProductAgentDir(),
			piExecutable: process.env.ROTOM_TEST_PI,
			excludedResourceKeys: ["skill:pi-subagents"],
		});
		const manifest = await createProductRunManifest({
			selection: product,
			workspace: root,
			model: { provider: "fixture", id: "fixture-model" },
			thinkingLevel: "off",
			environmentProfile: "unit-test",
		});

		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.workspaceFixtureDigestMode).toBe("full");
		expect(manifest.workspaceFixtureDigest).toBe(firstDigest);
		expect(manifest.pi.version).toBe(product.verified.version);
		expect(manifest.product.resources).not.toContainEqual(expect.objectContaining({ key: "skill:pi-subagents" }));
		expect(manifest.product.resources).toContainEqual(
			expect.objectContaining({ key: "extension:browser", digest: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("can omit volatile nested Git metadata from an explicitly working-tree-bound fixture digest", async () => {
	const root = await mkdtemp(join(tmpdir(), "dev-agent-eval-working-tree-digest-test-"));
	try {
		await mkdir(resolve(root, ".git"));
		await mkdir(resolve(root, "nested"));
		await writeFile(resolve(root, "nested/input.txt"), "fixture\n");
		await writeFile(resolve(root, ".git/index"), "first volatile index\n");
		const fullBefore = await digestWorkspaceFixture(root);
		const workingTreeBefore = await digestWorkspaceFixture(root, "working-tree");

		await writeFile(resolve(root, ".git/index"), "second volatile index\n");
		expect(await digestWorkspaceFixture(root)).not.toBe(fullBefore);
		expect(await digestWorkspaceFixture(root, "working-tree")).toBe(workingTreeBefore);

		await rm(resolve(root, ".git"), { recursive: true });
		await writeFile(resolve(root, ".git"), "gitdir: /volatile/worktree/path\n");
		expect(await digestWorkspaceFixture(root, "working-tree")).toBe(workingTreeBefore);

		await writeFile(resolve(root, "nested/input.txt"), "changed fixture\n");
		expect(await digestWorkspaceFixture(root, "working-tree")).not.toBe(workingTreeBefore);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
