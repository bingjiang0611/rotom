import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { RESOURCE_DESCRIPTORS_V1 } from "./product-config.mjs";
import { verifyPiRuntime } from "./verify-pi-runtime.mjs";

function commandPath(name) {
	return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

test("public DefaultResourceLoader preserves user prompts and business context without maintenance context", async () => {
	const agentDir = resolve(import.meta.dirname, "..");
	const root = await mkdtemp(resolve(tmpdir(), "rotom-context-discovery-"));
	const businessRoot = resolve(root, "business-repo");
	const businessCwd = resolve(businessRoot, "packages/app/src");
	const configDir = resolve(root, "config");
	try {
		await mkdir(resolve(businessRoot, ".git"), { recursive: true });
		await mkdir(businessCwd, { recursive: true });
		await mkdir(resolve(configDir, "prompts"), { recursive: true });
		// Retiring bundled commands must not blacklist a user's same-named template.
		await writeFile(resolve(configDir, "prompts/parallel-review.md"), "---\ndescription: User-owned review\n---\n\nReview my project.\n", { mode: 0o600 });
		await writeFile(resolve(configDir, "AGENTS.md"), "GLOBAL_CONTEXT_SENTINEL\n", { mode: 0o600 });
		await writeFile(resolve(businessRoot, "AGENTS.md"), "ROOT_CONTEXT_SENTINEL\n", { mode: 0o600 });
		await writeFile(resolve(businessRoot, "packages/app/CLAUDE.md"), "NESTED_CONTEXT_SENTINEL_V1\n", { mode: 0o600 });

		const executable = process.env.ROTOM_PI || commandPath("pi");
		const declarations = RESOURCE_DESCRIPTORS_V1.map((resource) => `${resource.kind}:${resolve(agentDir, resource.path)}`);
		const verified = await verifyPiRuntime({ executable, agentDir, resourceDeclarations: declarations });
		const pi = await import(pathToFileURL(verified.publicEntry).href);
		const settingsManager = pi.SettingsManager.create(businessCwd, configDir, { projectTrusted: false });
		const loader = new pi.DefaultResourceLoader({
			cwd: businessCwd,
			agentDir: configDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: false,
			noThemes: true,
			noContextFiles: false,
		});
		await loader.reload();

		assert.deepEqual(loader.getPrompts().prompts.map((prompt) => prompt.name), ["parallel-review"], "user-owned templates remain discoverable");
		const first = loader.getAgentsFiles().agentsFiles;
		assert.deepEqual(first.map(({ content }) => content), [
			"GLOBAL_CONTEXT_SENTINEL\n",
			"ROOT_CONTEXT_SENTINEL\n",
			"NESTED_CONTEXT_SENTINEL_V1\n",
		]);
		assert.deepEqual(first.map(({ path }) => resolve(path)), [
			resolve(configDir, "AGENTS.md"),
			resolve(businessRoot, "AGENTS.md"),
			resolve(businessRoot, "packages/app/CLAUDE.md"),
		]);
		for (const file of first) assert.equal(resolve(file.path).startsWith(`${resolve(agentDir, "..")}\/`), false, "maintenance repository context must not be injected");

		await writeFile(resolve(businessRoot, "packages/app/CLAUDE.md"), "NESTED_CONTEXT_SENTINEL_V2\n", { mode: 0o600 });
		await loader.reload();
		assert.equal(loader.getAgentsFiles().agentsFiles.at(-1)?.content, "NESTED_CONTEXT_SENTINEL_V2\n", "native reload must refresh business context");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
