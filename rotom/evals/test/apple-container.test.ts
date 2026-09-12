import { describe, expect, it } from "vitest";
import {
	buildAppleContainerRunArgs,
	parseAppleContainerEvalArgs,
} from "../src/apple-container.ts";

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
		expect(() => parseAppleContainerEvalArgs(["--pi=/host/pi"])).toThrow("controlled by the container image");
		expect(() => parseAppleContainerEvalArgs(["--container-image=--debug"])).toThrow("unsupported characters");
	});
});

it("builds a least-privilege Apple container run command", () => {
	const options = parseAppleContainerEvalArgs([
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
	expect(args.slice(-2)).toEqual([
		"--provider=openai",
		"--model=gpt-5.6-sol",
	]);
});
