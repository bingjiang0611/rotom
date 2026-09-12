import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareEvalChildEnvironment } from "./eval-environment.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = process.env.ROTOM_EVAL_ARTIFACT_DIR
	? resolve(packageRoot, process.env.ROTOM_EVAL_ARTIFACT_DIR)
	: resolve(packageRoot, ".eval", `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`);
const jsonReport = resolve(artifactDirectory, "vitest-results.json");
const args = process.argv.slice(2);
let provider;
let model;
let piExecutable;
let hasCliModelSelection = false;
let allowHostSideEffects = process.env.ROTOM_EVAL_ALLOW_HOST_SIDE_EFFECTS === "1";
const vitestArgs = [];

for (let index = 0; index < args.length; index += 1) {
	const argument = args[index];
	if (argument === "--allow-host-side-effects") {
		allowHostSideEffects = true;
		continue;
	}
	if (["--provider", "--model", "--pi"].includes(argument)) {
		const value = args[index + 1];
		if (!value || value.startsWith("-")) {
			console.error(`Missing value for ${argument}`);
			process.exit(1);
		}
		if (argument === "--provider") provider = value;
		else if (argument === "--model") model = value;
		else if (argument === "--pi") piExecutable = value;
		if (argument === "--provider" || argument === "--model") hasCliModelSelection = true;
		index += 1;
		continue;
	}
	if (argument.startsWith("--provider=")) {
		provider = argument.slice("--provider=".length);
		hasCliModelSelection = true;
		continue;
	}
	if (argument.startsWith("--model=")) {
		model = argument.slice("--model=".length);
		hasCliModelSelection = true;
		continue;
	}
	if (argument.startsWith("--pi=")) {
		piExecutable = argument.slice("--pi=".length);
		continue;
	}
	vitestArgs.push(argument);
}

provider = provider?.trim() || undefined;
model = model?.trim() || undefined;
if (hasCliModelSelection && (!provider || !model)) {
	console.error("CLI model selection requires both --provider and --model.");
	process.exit(1);
}
if (!hasCliModelSelection) {
	provider = process.env.ROTOM_EVAL_PROVIDER?.trim() || undefined;
	model = process.env.ROTOM_EVAL_MODEL?.trim() || undefined;
	if (Boolean(provider) !== Boolean(model)) {
		console.error("Default model selection requires both ROTOM_EVAL_PROVIDER and ROTOM_EVAL_MODEL.");
		process.exit(1);
	}
}

piExecutable = piExecutable?.trim() || process.env.ROTOM_PI?.trim() || undefined;
if (piExecutable && !isAbsolute(piExecutable)) {
	console.error("Pi executable must be an absolute path.");
	process.exit(1);
}
const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve("vitest/package.json");
const vitestCliPath = resolve(dirname(vitestPackagePath), "vitest.mjs");

mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
console.error(`[eval] default-model=${provider && model ? `${provider}/${model}` : "none"}`);
console.error(`[eval] pi=${piExecutable ?? "PATH"}`);
console.error(`[eval] host-side-effects=${allowHostSideEffects ? "allowed" : "blocked-by-default"}`);
console.error(`[eval] artifacts=${artifactDirectory}`);

const preparedEnvironment = prepareEvalChildEnvironment({
	...process.env,
	ROTOM_EVAL_ARTIFACT_DIR: artifactDirectory,
	ROTOM_EVAL_JSON_REPORT: jsonReport,
});
const childEnvironment = preparedEnvironment.environment;
console.error(`[eval] node-env-proxy=${preparedEnvironment.nodeEnvProxy ? "enabled" : "disabled"}`);
if (provider && model) {
	childEnvironment.ROTOM_EVAL_PROVIDER = provider;
	childEnvironment.ROTOM_EVAL_MODEL = model;
} else {
	delete childEnvironment.ROTOM_EVAL_PROVIDER;
	delete childEnvironment.ROTOM_EVAL_MODEL;
}
if (piExecutable) childEnvironment.ROTOM_PI = piExecutable;
if (allowHostSideEffects) childEnvironment.ROTOM_EVAL_ALLOW_HOST_SIDE_EFFECTS = "1";
else delete childEnvironment.ROTOM_EVAL_ALLOW_HOST_SIDE_EFFECTS;

const result = spawnSync(process.execPath, [vitestCliPath, "run", "--config", "vitest.config.ts", ...vitestArgs], {
	cwd: packageRoot,
	stdio: "inherit",
	env: childEnvironment,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
