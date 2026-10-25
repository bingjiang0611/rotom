import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	buildAppleContainerRunArgs,
	parseAppleContainerEvalArgs,
	withAppleContainerBuildContext,
} from "../src/apple-container.ts";

it.each([false, true])("archives nested working-tree files and cleans the build context (failure=%s)", async (fail) => {
	const root = await mkdtemp(join(tmpdir(), "rotom-eval-build-test-"));
	let buildDirectory = "";
	try {
		for (const [file, content] of Object.entries({
			"Containerfile": "ADD source.tar /app/\n",
			"package.json": "{}\n",
			"package-lock.json": "{}\n",
			"bin/test": "#!/bin/sh\nexit 0\n",
			"src/nested/current.ts": "export const current = true;\n",
			"node_modules/ignored.txt": "installed dependency\n",
			".eval/private.txt": "private fixture artifact\n",
		})) {
			const path = join(root, file);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, { mode: 0o755 });
		}
		await chmod(join(root, "bin/test"), 0o755);
		const build = withAppleContainerBuildContext(root, async (directory) => {
			buildDirectory = directory;
			expect((await readdir(directory)).sort()).toEqual(["Containerfile", "package-lock.json", "package.json", "source.tar"]);
			const extracted = join(root, "extracted");
			await mkdir(extracted);
			await promisify(execFile)("tar", ["-xpf", join(directory, "source.tar"), "-C", extracted]);
			expect(await readFile(join(extracted, "src/nested/current.ts"), "utf8")).toBe("export const current = true;\n");
			expect((await stat(join(extracted, "bin/test"))).mode & 0o111).toBe(0o111);
			for (const excluded of ["node_modules", ".eval"]) {
				await expect(stat(join(extracted, excluded))).rejects.toMatchObject({ code: "ENOENT" });
			}
			if (fail) throw new Error("build failed");
			return 23;
		});
		if (fail) await expect(build).rejects.toThrow("build failed");
		else expect(await build).toBe(23);
		await expect(stat(buildDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

describe("parseAppleContainerEvalArgs", () => {
	it("keeps eval arguments separate from explicit container controls", () => {
		const options = parseAppleContainerEvalArgs([
			"--container-cpus=6",
			"--container-memory",
			"12G",
			"--container-env=OPENAI_API_KEY",
			"--container-env",
			"ANTHROPIC_API_KEY",
			"--provider=openai",
			"--model",
			"gpt-5.6-sol",
		]);

		expect(options.cpus).toBe("6");
		expect(options.memory).toBe("12G");
		expect(options.environmentNames).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
		expect(options.evalArgs).toEqual(["--provider=openai", "--model", "gpt-5.6-sol"]);
	});

	it("requires explicit absolute host paths and protects runner-owned values", () => {
		expect(() => parseAppleContainerEvalArgs(["--container-auth=relative.json"])).toThrow("absolute path");
		expect(() => parseAppleContainerEvalArgs(["--container-env=ROTOM_PI"])).toThrow("controlled");
		expect(() => parseAppleContainerEvalArgs(["--pi=/host/pi"])).toThrow("controlled by the container runner");
		expect(() => parseAppleContainerEvalArgs(["--container-image=--debug"])).toThrow("unsupported characters");
	});
});

it.each(["eval", "test"] as const)("builds a least-privilege Apple container %s command using candidate Pi", (command) => {
	const options = parseAppleContainerEvalArgs([
		`--container-command=${command}`,
		"--container-env=OPENAI_API_KEY",
		"--provider=openai",
		"--model=gpt-5.6-sol",
	]);
	const args = buildAppleContainerRunArgs(options, {
		productAgentDir: "/host/dev-agent/rotom",
		artifactDirectory: "/host/eval-artifacts",
		secretsDirectory: "/host/eval-secrets",
		uid: 501,
		gid: 20,
		containerName: "dev-agent-eval-fixture",
		containerCliVersion: "container CLI version 1.2.2",
		imageDigest: `sha256:${"a".repeat(64)}`,
		git: {
			gitHead: "b".repeat(40),
			gitDirty: true,
			gitWorktreeDigest: "c".repeat(64),
		},
	});

	expect(args).toContain("--read-only");
	expect(args).toContain("ALL");
	expect(args).toContain("type=bind,source=/host/dev-agent/rotom,target=/workspace/product,readonly");
	expect(args).toContain("type=bind,source=/host/eval-artifacts,target=/artifacts");
	expect(args).toContain("type=bind,source=/host/eval-secrets,target=/run/secrets,readonly");
	expect(args).toContain("type=tmpfs,target=/tmp,size=2G,mode=1777");
	expect(args).toContain("type=tmpfs,target=/opt/dev-agent-evals/node_modules/.vite-temp,size=64M,mode=1777");
	expect(args).toContain("ROTOM_EVAL_EXECUTION_KIND=apple-container");
	expect(args).toContain("OPENAI_API_KEY");
	expect(args.some((arg) => /^(?:ROTOM_PI|ROTOM_TEST_PI)=/u.test(arg))).toBe(false);
	expect(args.includes("__infrastructure_test__")).toBe(command === "test");
	expect(args.slice(-2)).toEqual([
		"--provider=openai",
		"--model=gpt-5.6-sol",
	]);
});
