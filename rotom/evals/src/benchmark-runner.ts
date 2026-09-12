import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_HARBOR_VERSION = "0.22.0";
export const DEV_AGENT_PI_VERSION = "0.84.3";
export const SWE_BENCH_MULTILINGUAL_DATASET = "swebench_multilingual@1.0";
export const SWE_BENCH_MULTILINGUAL_REGISTRY =
	"https://raw.githubusercontent.com/harbor-framework/harbor/b37833221e27435a18d7acdd41d875cdc2831893/registry.json";
export const TERMINAL_BENCH_2_DATASET = "terminal-bench/terminal-bench-2";
export const TERMINAL_BENCH_21_DATASET = "terminal-bench@2.1";
export const TERMINAL_BENCH_21_REVISION = "d49e28f1e4ddd13d289e85a5f312a66750951932";
export const TERMINAL_BENCH_21_REGISTRY = fileURLToPath(new URL("../profiles/terminal-bench-2.1.registry.json", import.meta.url));
export const NATIVE_PI_HARBOR_AGENT = "benchmark_adapters.dev_agent_pi:NativePi";
export const DEV_AGENT_HARBOR_AGENT = "benchmark_adapters.dev_agent_pi:DevAgentPi";
export const AMD64_APPLE_CONTAINER_ENVIRONMENT =
	"benchmark_adapters.harbor_environment:Amd64AppleContainerEnvironment";

export type BenchmarkName = "swe-bench-multilingual" | "terminal-bench-2" | "terminal-bench-2.1";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type BenchmarkArm = "dev-agent" | "native-pi";
export type BenchmarkEnvironment = "apple-container-amd64" | "apple-container-native" | "docker";

export type BenchmarkRunnerOptions = {
	benchmark: BenchmarkName;
	arm: BenchmarkArm;
	piVersion: string;
	thinking?: (typeof THINKING_LEVELS)[number];
	harborCli: string;
	provider: string;
	model: string;
	productAgentDir: string;
	jobsDir: string;
	environment: BenchmarkEnvironment;
	nConcurrent: number;
	nAttempts: number;
	setupTimeoutMultiplier: number;
	nTasks?: number;
	tasks: string[];
	runName?: string;
	dryRun: boolean;
	passthrough: string[];
};

type ParseDefaults = {
	productAgentDir: string;
	jobsDir: string;
};

function parseBenchmarkName(value: string): BenchmarkName {
	if (value === "swe-bench-multilingual" || value === "swe") return "swe-bench-multilingual";
	if (value === "terminal-bench-2" || value === "terminal") return "terminal-bench-2";
	if (value === "terminal-bench-2.1") return "terminal-bench-2.1";
	throw new TypeError(`Unknown benchmark: ${value}`);
}

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

function positiveInteger(name: string, value: string): number {
	if (!/^[1-9]\d*$/u.test(value)) throw new TypeError(`${name} must be a positive integer.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} is too large.`);
	return parsed;
}

function positiveNumber(name: string, value: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive number.`);
	return parsed;
}

function absolutePath(name: string, value: string): string {
	if (!isAbsolute(value)) throw new TypeError(`${name} must be an absolute path.`);
	if (value.includes("\0")) throw new TypeError(`${name} contains a null byte.`);
	return value;
}

function nonEmpty(name: string, value: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new TypeError(`${name} must not be empty.`);
	if (trimmed.includes("\0")) throw new TypeError(`${name} contains a null byte.`);
	return trimmed;
}

function parseEnvironment(value: string): BenchmarkEnvironment {
	if (value === "apple-container-amd64" || value === "apple-container-native" || value === "docker") {
		return value;
	}
	throw new TypeError("Environment must be apple-container-amd64, apple-container-native, or docker.");
}

const protectedPassthroughOptions = [
	"--agent",
	"-a",
	"--agent-kwarg",
	"--ak",
	"--agent-setup-timeout-multiplier",
	"--dataset",
	"-d",
	"--disable-verification",
	"--env",
	"-e",
	"--exclude-task-name",
	"-x",
	"--include-task-name",
	"-i",
	"--install-only",
	"--job-name",
	"--jobs-dir",
	"-o",
	"--model",
	"-m",
	"--n-attempts",
	"-k",
	"--n-concurrent",
	"-n",
	"--n-tasks",
	"--path",
	"-p",
	"--registry-path",
	"--registry-url",
	"--repo",
	"--task",
	"-t",
];

function validatePassthrough(args: readonly string[]): string[] {
	for (const argument of args) {
		const protectedOption = protectedPassthroughOptions.find(
			(option) => argument === option || argument.startsWith(`${option}=`),
		);
		if (protectedOption) {
			throw new TypeError(`Harbor option ${protectedOption} is controlled by the benchmark runner.`);
		}
	}
	return [...args];
}

export function parseBenchmarkRunnerArgs(
	args: readonly string[],
	defaults: ParseDefaults,
	environment: NodeJS.ProcessEnv = process.env,
): BenchmarkRunnerOptions {
	if (args.length === 0) throw new TypeError("Select swe-bench-multilingual, terminal-bench-2 or terminal-bench-2.1.");
	const benchmark = parseBenchmarkName(args[0]);
	let arm: BenchmarkArm = "dev-agent";
	let piVersion = DEV_AGENT_PI_VERSION;
	let thinking: BenchmarkRunnerOptions["thinking"];
	let provider = environment.ROTOM_EVAL_PROVIDER?.trim() ?? "";
	let model = environment.ROTOM_EVAL_MODEL?.trim() ?? "";
	let productAgentDir = defaults.productAgentDir;
	let jobsDir = defaults.jobsDir;
	let harborCli = environment.ROTOM_HARBOR?.trim() || "harbor";
	let benchmarkEnvironment: BenchmarkEnvironment = "apple-container-amd64";
	let nConcurrent = 1;
	let nAttempts = 1;
	let setupTimeoutMultiplier = 5;
	let nTasks: number | undefined = 1;
	let nTasksExplicit = false;
	let allTasks = false;
	let runName: string | undefined;
	let dryRun = false;
	const tasks: string[] = [];
	let passthrough: string[] = [];

	const definitions: Array<[
		string,
		(value: string) => void,
	]> = [
		["--arm", (value) => {
			if (value !== "dev-agent" && value !== "native-pi") throw new TypeError("Arm must be dev-agent or native-pi.");
			arm = value;
		}],
		["--pi-version", (value) => {
			if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(value)) throw new TypeError("Pi version must be an exact semver.");
			piVersion = value;
		}],
		["--thinking", (value) => {
			thinking = THINKING_LEVELS.find((level) => level === value);
			if (thinking === undefined) throw new TypeError("Thinking must be off/minimal/low/medium/high/xhigh.");
		}],
		["--provider", (value) => (provider = nonEmpty("Provider", value))],
		["--model", (value) => (model = nonEmpty("Model", value))],
		["--product", (value) => (productAgentDir = absolutePath("Product agent directory", value))],
		["--jobs-dir", (value) => (jobsDir = absolutePath("Jobs directory", value))],
		["--harbor", (value) => (harborCli = nonEmpty("Harbor CLI", value))],
		["--environment", (value) => (benchmarkEnvironment = parseEnvironment(value))],
		["--n-concurrent", (value) => (nConcurrent = positiveInteger("Concurrency", value))],
		["--attempts", (value) => (nAttempts = positiveInteger("Attempts", value))],
		[
			"--setup-timeout-multiplier",
			(value) => (setupTimeoutMultiplier = positiveNumber("Setup timeout multiplier", value)),
		],
		["--n-tasks", (value) => { nTasks = positiveInteger("Task count", value); nTasksExplicit = true; }],
		["--task", (value) => tasks.push(nonEmpty("Task", value))],
		["--run-name", (value) => (runName = nonEmpty("Run name", value))],
	];

	for (let index = 1; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			passthrough = validatePassthrough(args.slice(index + 1));
			break;
		}
		if (argument === "--all") {
			nTasks = undefined;
			allTasks = true;
			continue;
		}
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		let matched = false;
		for (const [name, assign] of definitions) {
			const parsed = valueOption(argument, name, args, index);
			if (!parsed.matched) continue;
			assign(parsed.value);
			index = parsed.nextIndex;
			matched = true;
			break;
		}
		if (!matched) throw new TypeError(`Unknown benchmark option: ${argument}. Use -- before Harbor options.`);
	}

	if (allTasks && (nTasksExplicit || tasks.length > 0)) throw new TypeError("--all cannot be combined with --n-tasks or --task.");
	if (tasks.length > 0 && !nTasksExplicit) nTasks = tasks.length;
	if (tasks.length > 0 && nTasks !== undefined && nTasks < tasks.length) throw new TypeError("--n-tasks cannot be smaller than the number of explicit --task filters.");
	provider = nonEmpty("Provider", provider);
	model = nonEmpty("Model", model);
	productAgentDir = absolutePath("Product agent directory", productAgentDir);
	jobsDir = absolutePath("Jobs directory", jobsDir);
	if (model.includes("/") && !model.startsWith(`${provider}/`)) {
		throw new TypeError("When model includes a provider prefix, it must match --provider.");
	}
	if (runName && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runName)) {
		throw new TypeError("Run name may contain only letters, digits, dot, underscore, and hyphen.");
	}

	return {
		benchmark,
		arm,
		piVersion,
		...(thinking === undefined ? {} : { thinking }),
		harborCli,
		provider,
		model,
		productAgentDir,
		jobsDir,
		environment: benchmarkEnvironment,
		nConcurrent,
		nAttempts,
		setupTimeoutMultiplier,
		...(nTasks === undefined ? {} : { nTasks }),
		tasks,
		...(runName ? { runName } : {}),
		dryRun,
		passthrough,
	};
}

export function harborModelName(options: Pick<BenchmarkRunnerOptions, "provider" | "model">): string {
	return options.model.includes("/") ? options.model : `${options.provider}/${options.model}`;
}

export function buildHarborBenchmarkArgs(options: BenchmarkRunnerOptions, generatedRunName: string): string[] {
	const runName = options.runName ?? generatedRunName;
	const args = [
		"run",
		"--yes",
		"--job-name",
		runName,
		"--jobs-dir",
		options.jobsDir,
		"--agent",
		options.arm === "native-pi" ? NATIVE_PI_HARBOR_AGENT : DEV_AGENT_HARBOR_AGENT,
		"--model",
		harborModelName(options),
		"--agent-kwarg",
		`version=${options.piVersion}`,
		"--n-concurrent",
		String(options.nConcurrent),
		"--n-attempts",
		String(options.nAttempts),
		"--agent-setup-timeout-multiplier",
		String(options.setupTimeoutMultiplier),
	];

	if (options.arm === "dev-agent") args.push("--agent-kwarg", `product_agent_dir=${options.productAgentDir}`);
	if (options.thinking !== undefined) args.push("--agent-kwarg", `thinking=${options.thinking}`);

	if (options.environment === "apple-container-amd64") {
		args.push("--env", AMD64_APPLE_CONTAINER_ENVIRONMENT);
	} else if (options.environment === "apple-container-native") {
		args.push("--env", "apple-container");
	} else {
		args.push("--env", "docker");
	}

	if (options.benchmark === "swe-bench-multilingual") {
		args.push(
			"--dataset",
			SWE_BENCH_MULTILINGUAL_DATASET,
			"--registry-url",
			SWE_BENCH_MULTILINGUAL_REGISTRY,
		);
	} else if (options.benchmark === "terminal-bench-2.1") {
		args.push("--dataset", TERMINAL_BENCH_21_DATASET, "--registry-path", TERMINAL_BENCH_21_REGISTRY);
	} else {
		args.push("--dataset", TERMINAL_BENCH_2_DATASET);
	}

	if (options.nTasks !== undefined) args.push("--n-tasks", String(options.nTasks));
	for (const task of options.tasks) args.push("--include-task-name", task);
	args.push(...options.passthrough);
	return args;
}

export const benchmarkUsage = `Usage:
  npm run benchmark -- doctor [--live]
  npm run benchmark -- swe-bench-multilingual --provider=<id> --model=<id> [options]
  npm run benchmark -- terminal-bench-2 --provider=<id> --model=<id> [options]
  npm run benchmark -- terminal-bench-2.1 --provider=<id> --model=<id> [options]

Runner options:
  --arm=dev-agent|native-pi               Default: dev-agent; same Node 24/Pi installer
  --pi-version=X.Y.Z                     Exact Pi version; default: 0.84.3
  --thinking=high                        Explicit Pi thinking level for both arms
  --product=/absolute/path/to/rotom    Product worktree or snapshot to evaluate
  --environment=apple-container-amd64    Default; Harbor + Apple container + Rosetta
  --environment=apple-container-native   Native arm64 images only
  --environment=docker                   Official Docker backend
  --n-tasks=N                            Default: 1
  --all                                  Run the complete dataset
  --task=NAME                            Repeatable task-name filter
  --n-concurrent=N                       Default: 1
  --attempts=N                           Default: 1
  --setup-timeout-multiplier=N           Default: 5; affects agent installation only
  --run-name=NAME                        Stable label for baseline/candidate runs
  --jobs-dir=/absolute/path              Default: eval .eval/benchmarks directory
  --dry-run                              Print the Harbor command without running it
  -- <harbor options>                    Forward non-owned Harbor controls
`;
