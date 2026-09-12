import { isAbsolute } from "node:path";
import type { ProductGitIdentity } from "./product-runtime.ts";

export const DEFAULT_APPLE_CONTAINER_IMAGE = "dev-agent-evals:local";

export type AppleContainerEvalOptions = {
	containerCli: string;
	image: string;
	command: "eval" | "test";
	build: boolean;
	cpus: string;
	memory: string;
	tmpfs: string;
	network: string;
	artifactDirectory?: string;
	productAgentDir?: string;
	authFile?: string;
	modelsFile?: string;
	environmentNames: string[];
	evalArgs: string[];
};

export type AppleContainerRunContext = {
	productAgentDir: string;
	artifactDirectory: string;
	secretsDirectory?: string;
	uid: number;
	gid: number;
	containerName: string;
	containerCliVersion: string;
	imageDigest: string;
	git: ProductGitIdentity;
};

const controlledEnvironmentNames = new Set([
	"HOME",
	"ROTOM_EVAL_ARTIFACT_DIR",
	"ROTOM_EVAL_AUTH_SOURCE",
	"ROTOM_EVAL_CACHE_DIR",
	"ROTOM_EVAL_CONTAINER_CPUS",
	"ROTOM_EVAL_CONTAINER_CLI_VERSION",
	"ROTOM_EVAL_CONTAINER_IMAGE",
	"ROTOM_EVAL_CONTAINER_IMAGE_DIGEST",
	"ROTOM_EVAL_CONTAINER_MEMORY",
	"ROTOM_EVAL_CONTAINER_NETWORK",
	"ROTOM_EVAL_ENVIRONMENT_PROFILE",
	"ROTOM_EVAL_EXECUTION_KIND",
	"ROTOM_EVAL_MODELS_SOURCE",
	"ROTOM_EVAL_PRODUCT_GIT_DIRTY",
	"ROTOM_EVAL_PRODUCT_GIT_HEAD",
	"ROTOM_EVAL_PRODUCT_GIT_WORKTREE_DIGEST",
	"ROTOM_NODE",
	"ROTOM_PI",
	"ROTOM_TEST_PI",
	"ROTOM_PRODUCT_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"TMPDIR",
	"XDG_CACHE_HOME",
]);

function valueOption(
	argument: string,
	name: string,
	args: readonly string[],
	index: number,
): { matched: false } | { matched: true; value: string; nextIndex: number } {
	if (argument === name) {
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${name}.`);
		return { matched: true, value, nextIndex: index + 1 };
	}
	const prefix = `${name}=`;
	if (argument.startsWith(prefix)) {
		const value = argument.slice(prefix.length);
		if (!value) throw new TypeError(`Missing value for ${name}.`);
		return { matched: true, value, nextIndex: index };
	}
	return { matched: false };
}

function assertResourceNumber(name: string, value: string): string {
	if (!/^(?:[1-9]\d*|0\.\d+)$/u.test(value)) throw new TypeError(`${name} must be a positive number.`);
	return value;
}

function assertMemory(name: string, value: string): string {
	if (!/^[1-9]\d*(?:[KMGTP](?:B)?)?$/iu.test(value)) {
		throw new TypeError(`${name} must be a positive byte value such as 8G.`);
	}
	return value;
}

function assertSimpleValue(name: string, value: string): string {
	if (!value.trim() || value.startsWith("-") || /[\s,\0]/u.test(value)) {
		throw new TypeError(`${name} contains unsupported characters.`);
	}
	return value;
}

function assertOptionalAbsolutePath(name: string, value: string): string {
	if (!isAbsolute(value)) throw new TypeError(`${name} must be an absolute path.`);
	if (value.includes(",") || value.includes("\0")) throw new TypeError(`${name} contains unsupported characters.`);
	return value;
}

function assertEnvironmentName(value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new TypeError(`Invalid environment name: ${value}`);
	if (controlledEnvironmentNames.has(value)) {
		throw new TypeError(`Environment ${value} is controlled by the container runner.`);
	}
	return value;
}

export function parseAppleContainerEvalArgs(
	args: readonly string[],
	environment: NodeJS.ProcessEnv = process.env,
): AppleContainerEvalOptions {
	const options: AppleContainerEvalOptions = {
		containerCli: environment.ROTOM_CONTAINER_CLI?.trim() || "container",
		image: environment.ROTOM_EVAL_CONTAINER_IMAGE?.trim() || DEFAULT_APPLE_CONTAINER_IMAGE,
		command: "eval",
		build: true,
		cpus: environment.ROTOM_EVAL_CONTAINER_CPUS?.trim() || "4",
		memory: environment.ROTOM_EVAL_CONTAINER_MEMORY?.trim() || "8G",
		tmpfs: environment.ROTOM_EVAL_CONTAINER_TMPFS?.trim() || "2G",
		network: environment.ROTOM_EVAL_CONTAINER_NETWORK?.trim() || "default",
		environmentNames: [],
		evalArgs: [],
	};
	const environmentNames = new Set<string>();

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			options.evalArgs.push(...args.slice(index + 1));
			break;
		}
		if (argument === "--no-container-build") {
			options.build = false;
			continue;
		}
		const commandOption = valueOption(argument, "--container-command", args, index);
		if (commandOption.matched) {
			if (commandOption.value !== "eval" && commandOption.value !== "test") {
				throw new TypeError("Container command must be eval or test.");
			}
			options.command = commandOption.value;
			index = commandOption.nextIndex;
			continue;
		}

		const definitions: Array<[string, keyof Pick<AppleContainerEvalOptions,
			"containerCli" | "image" | "cpus" | "memory" | "tmpfs" | "network" | "artifactDirectory" | "productAgentDir" | "authFile" | "modelsFile"
		>]> = [
			["--container-cli", "containerCli"],
			["--container-image", "image"],
			["--container-cpus", "cpus"],
			["--container-memory", "memory"],
			["--container-tmpfs", "tmpfs"],
			["--container-network", "network"],
			["--container-artifacts", "artifactDirectory"],
			["--container-product", "productAgentDir"],
			["--container-auth", "authFile"],
			["--container-models", "modelsFile"],
		];
		let matched = false;
		for (const [name, property] of definitions) {
			const parsed = valueOption(argument, name, args, index);
			if (!parsed.matched) continue;
			options[property] = parsed.value;
			index = parsed.nextIndex;
			matched = true;
			break;
		}
		if (matched) continue;

		const environmentOption = valueOption(argument, "--container-env", args, index);
		if (environmentOption.matched) {
			environmentNames.add(assertEnvironmentName(environmentOption.value));
			index = environmentOption.nextIndex;
			continue;
		}
		options.evalArgs.push(argument);
	}

	options.containerCli = options.containerCli.trim();
	if (!options.containerCli) throw new TypeError("Container CLI must not be empty.");
	options.image = assertSimpleValue("Container image", options.image);
	if (options.command !== "eval" && options.command !== "test") {
		throw new TypeError("Container command must be eval or test.");
	}
	options.cpus = assertResourceNumber("Container CPUs", options.cpus);
	options.memory = assertMemory("Container memory", options.memory);
	options.tmpfs = assertMemory("Container tmpfs", options.tmpfs);
	options.network = assertSimpleValue("Container network", options.network);
	if (options.artifactDirectory) {
		options.artifactDirectory = assertOptionalAbsolutePath("Container artifact directory", options.artifactDirectory);
	}
	if (options.productAgentDir) {
		options.productAgentDir = assertOptionalAbsolutePath("Container product directory", options.productAgentDir);
	}
	if (options.authFile) options.authFile = assertOptionalAbsolutePath("Container auth file", options.authFile);
	if (options.modelsFile) options.modelsFile = assertOptionalAbsolutePath("Container models file", options.modelsFile);
	if (options.evalArgs.some((value) => value === "--pi" || value.startsWith("--pi="))) {
		throw new TypeError("--pi is controlled by the container image; use --container-image for a custom Pi runtime.");
	}
	options.environmentNames = [...environmentNames].sort();
	return options;
}

function environmentArgument(name: string, value: string): [string, string] {
	return ["--env", `${name}=${value}`];
}

export function buildAppleContainerRunArgs(
	options: AppleContainerEvalOptions,
	context: AppleContainerRunContext,
): string[] {
	const mount = (source: string, target: string, readonly = false) =>
		`type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
	const args = [
		"run",
		"--rm",
		"--init",
		"--name",
		context.containerName,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--cpus",
		options.cpus,
		"--memory",
		options.memory,
		"--network",
		options.network,
		"--uid",
		String(context.uid),
		"--gid",
		String(context.gid),
		"--mount",
		mount(context.productAgentDir, "/workspace/product", true),
		"--mount",
		mount(context.artifactDirectory, "/artifacts"),
		"--mount",
		`type=tmpfs,target=/tmp,size=${options.tmpfs},mode=1777`,
		"--mount",
		"type=tmpfs,target=/opt/dev-agent-evals/node_modules/.vite-temp,size=64M,mode=1777",
		...environmentArgument("ROTOM_EVAL_ARTIFACT_DIR", "/artifacts"),
		...environmentArgument("ROTOM_EVAL_CACHE_DIR", "/tmp/vitest-cache"),
		...environmentArgument("ROTOM_EVAL_ENVIRONMENT_PROFILE", "apple-container"),
		...environmentArgument("ROTOM_EVAL_EXECUTION_KIND", "apple-container"),
		...environmentArgument("ROTOM_EVAL_CONTAINER_CLI_VERSION", context.containerCliVersion),
		...environmentArgument("ROTOM_EVAL_CONTAINER_IMAGE", options.image),
		...environmentArgument("ROTOM_EVAL_CONTAINER_IMAGE_DIGEST", context.imageDigest),
		...environmentArgument("ROTOM_EVAL_CONTAINER_NETWORK", options.network),
		...environmentArgument("ROTOM_EVAL_CONTAINER_CPUS", options.cpus),
		...environmentArgument("ROTOM_EVAL_CONTAINER_MEMORY", options.memory),
		...environmentArgument("ROTOM_EVAL_PRODUCT_GIT_DIRTY", String(context.git.gitDirty)),
	];
	if (context.git.gitHead) args.push(...environmentArgument("ROTOM_EVAL_PRODUCT_GIT_HEAD", context.git.gitHead));
	if (context.git.gitWorktreeDigest) {
		args.push(...environmentArgument("ROTOM_EVAL_PRODUCT_GIT_WORKTREE_DIGEST", context.git.gitWorktreeDigest));
	}
	if (context.secretsDirectory) {
		args.push("--mount", mount(context.secretsDirectory, "/run/secrets", true));
		if (options.authFile) {
			args.push(...environmentArgument("ROTOM_EVAL_AUTH_SOURCE", "/run/secrets/auth.json"));
		}
		if (options.modelsFile) {
			args.push(...environmentArgument("ROTOM_EVAL_MODELS_SOURCE", "/run/secrets/models.json"));
		}
	}
	for (const name of options.environmentNames) args.push("--env", name);
	if (options.command === "test") {
		args.push(...environmentArgument("ROTOM_TEST_PI", "/opt/dev-agent-evals/node_modules/.bin/pi"));
		args.push(options.image, "__infrastructure_test__", ...options.evalArgs);
	} else {
		args.push(options.image, ...options.evalArgs);
	}
	return args;
}
