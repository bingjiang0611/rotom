import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
	SUPPORTED_HARBOR_VERSION,
	benchmarkUsage,
	buildHarborBenchmarkArgs,
	parseBenchmarkRunnerArgs,
} from "../src/benchmark-runner.ts";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultProductAgentDir = resolve(packageRoot, "..");
const defaultJobsDir = resolve(packageRoot, ".eval", "benchmarks");

async function resolveExecutable(command, label) {
	if (command.includes("/")) {
		if (!isAbsolute(command)) throw new TypeError(`${label} path must be absolute when it contains a slash.`);
		await access(command, constants.X_OK);
		return realpath(command);
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = resolve(directory, command);
		try {
			await access(candidate, constants.X_OK);
			return await realpath(candidate);
		} catch {
			// Continue through PATH.
		}
	}
	throw new Error(`Cannot find ${label}: ${command}`);
}

async function runStreaming(command, args, environment = process.env) {
	const child = spawn(command, args, { cwd: packageRoot, env: environment, stdio: "inherit" });
	return new Promise((resolveRun, rejectRun) => {
		child.once("error", rejectRun);
		child.once("exit", (code, signal) => {
			if (signal) rejectRun(new Error(`${command} terminated by ${signal}.`));
			else resolveRun(code ?? 1);
		});
	});
}

function adapterEnvironment() {
	return {
		...process.env,
		PYTHONPATH: [packageRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
	};
}

async function verifyHarborImport(harborCli) {
	const launcher = await readFile(harborCli, "utf8");
	const shebang = launcher.split(/\r?\n/u, 1)[0];
	if (!shebang.startsWith("#!/")) {
		throw new Error("Harbor launcher is not a Python script; cannot verify local adapters.");
	}
	const python = shebang.slice(2).trim();
	await execFileAsync(
		python,
		[
			"-c",
			"from benchmark_adapters.dev_agent_pi import DevAgentPi, NativePi; from benchmark_adapters.harbor_environment import Amd64AppleContainerEnvironment; print(DevAgentPi.name(), NativePi.name())",
		],
		{ cwd: packageRoot, env: adapterEnvironment(), encoding: "utf8", maxBuffer: 1024 * 1024 },
	);
}

async function doctor(live) {
	const harborCli = await resolveExecutable(process.env.ROTOM_HARBOR?.trim() || "harbor", "Harbor CLI");
	const containerCli = await resolveExecutable(process.env.ROTOM_CONTAINER_CLI?.trim() || "container", "Apple container CLI");
	const { stdout: harborVersionOutput } = await execFileAsync(harborCli, ["--version"], { encoding: "utf8" });
	const harborVersion = harborVersionOutput.trim();
	if (harborVersion !== SUPPORTED_HARBOR_VERSION) {
		throw new Error(`Harbor ${SUPPORTED_HARBOR_VERSION} is required; found ${harborVersion || "unknown"}.`);
	}
	const { stdout: containerVersionOutput } = await execFileAsync(containerCli, ["--version"], { encoding: "utf8" });
	const { stdout: statusOutput } = await execFileAsync(containerCli, ["system", "status"], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	if (!/^status\s+running$/mu.test(statusOutput)) throw new Error("Apple container service is not running.");
	await Promise.all([
		access(resolve(defaultProductAgentDir, "bin/rotom-launcher"), constants.X_OK),
		access(resolve(defaultProductAgentDir, "runtime/verify-pi-runtime.mjs"), constants.R_OK),
		verifyHarborImport(harborCli),
	]);
	console.error(`[benchmark-doctor] harbor=${harborVersion}`);
	console.error(`[benchmark-doctor] container=${containerVersionOutput.trim()}`);
	console.error(`[benchmark-doctor] adapters=importable`);
	console.error(`[benchmark-doctor] product=${defaultProductAgentDir}`);
	if (live) {
		console.error("[benchmark-doctor] probing linux/amd64 with Rosetta...");
		const status = await runStreaming(
			containerCli,
			["run", "--rm", "--platform", "linux/amd64", "--rosetta", "alpine:3.22", "uname", "-m"],
		);
		if (status !== 0) process.exit(status);
	}
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
	console.log(benchmarkUsage);
	process.exit(args.length === 0 ? 1 : 0);
}
if (args[0] === "doctor") {
	const unknown = args.slice(1).filter((argument) => argument !== "--live");
	if (unknown.length > 0) throw new TypeError(`Unknown doctor option: ${unknown[0]}`);
	await doctor(args.includes("--live"));
	process.exit(0);
}

const options = parseBenchmarkRunnerArgs(args, {
	productAgentDir: defaultProductAgentDir,
	jobsDir: defaultJobsDir,
});
const harborCli = await resolveExecutable(options.harborCli, "Harbor CLI");
const { stdout: versionOutput } = await execFileAsync(harborCli, ["--version"], { encoding: "utf8" });
if (versionOutput.trim() !== SUPPORTED_HARBOR_VERSION) {
	throw new Error(`Harbor ${SUPPORTED_HARBOR_VERSION} is required; found ${versionOutput.trim() || "unknown"}.`);
}
await Promise.all([
	access(resolve(options.productAgentDir, "bin/rotom-launcher"), constants.X_OK),
	access(resolve(options.productAgentDir, "runtime/verify-pi-runtime.mjs"), constants.R_OK),
	mkdir(options.jobsDir, { recursive: true, mode: 0o700 }),
	verifyHarborImport(harborCli),
]);

const generatedRunName = `${options.benchmark}_${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
const harborArgs = buildHarborBenchmarkArgs(options, generatedRunName);
console.error(`[benchmark] suite=${options.benchmark}`);
console.error(`[benchmark] arm=${options.arm} pi=${options.piVersion} thinking=${options.thinking ?? "native-default"}`);
console.error(`[benchmark] product=${options.arm === "dev-agent" ? options.productAgentDir : "none (native Pi)"}`);
console.error(`[benchmark] environment=${options.environment}`);
console.error(`[benchmark] model=${options.provider}/${options.model}`);
console.error(`[benchmark] tasks=${options.tasks.join(",") || (options.nTasks === undefined ? "all" : `first-${options.nTasks}`)}`);
console.error(`[benchmark] jobs=${options.jobsDir}`);
if (options.dryRun) {
	console.log(JSON.stringify([harborCli, ...harborArgs]));
} else {
	process.exitCode = await runStreaming(harborCli, harborArgs, adapterEnvironment());
}
