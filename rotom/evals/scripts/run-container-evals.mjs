import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
	buildAppleContainerRunArgs,
	parseAppleContainerEvalArgs,
} from "../src/apple-container.ts";
import { snapshotProductGitIdentity } from "../src/product-runtime.ts";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultProductAgentDir = resolve(packageRoot, "..");

async function resolveExecutable(command) {
	if (command.includes("/")) {
		if (!isAbsolute(command)) throw new TypeError("Container CLI path must be absolute when it contains a slash.");
		await access(command, constants.X_OK);
		return realpath(command);
	}
	for (const directory of (process.env.PATH ?? "").split(":")) {
		if (!directory) continue;
		const candidate = resolve(directory, command);
		try {
			await access(candidate, constants.X_OK);
			return await realpath(candidate);
		} catch {
			// Continue through PATH.
		}
	}
	throw new Error(`Cannot find Apple container CLI: ${command}`);
}

async function requireFile(path, label) {
	const resolved = await realpath(path);
	const info = await lstat(resolved);
	if (!info.isFile()) throw new TypeError(`${label} must be a regular file: ${path}`);
	return resolved;
}

async function requireDirectory(path, label) {
	const resolved = await realpath(path);
	const info = await lstat(resolved);
	if (!info.isDirectory()) throw new TypeError(`${label} must be a directory: ${path}`);
	if (resolved.includes(",")) throw new TypeError(`${label} path cannot contain a comma.`);
	return resolved;
}

async function runStreaming(command, args, cwd) {
	const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
	return new Promise((resolveRun, rejectRun) => {
		child.once("error", rejectRun);
		child.once("exit", (code, signal) => {
			if (signal) rejectRun(new Error(`${command} terminated by ${signal}.`));
			else resolveRun(code ?? 1);
		});
	});
}

async function inspectImage(command, image) {
	const { stdout } = await execFileAsync(command, ["image", "inspect", image], {
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	const parsed = JSON.parse(stdout);
	const digest = parsed?.[0]?.configuration?.descriptor?.digest;
	if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
		throw new Error(`Apple container returned no immutable digest for image ${image}.`);
	}
	return digest;
}

async function prepareSecrets(options) {
	if (!options.authFile && !options.modelsFile) return undefined;
	const directory = await mkdtemp(join(tmpdir(), "dev-agent-eval-secrets-"));
	try {
		if (options.authFile) {
			const source = await requireFile(options.authFile, "Pi auth file");
			const destination = join(directory, "auth.json");
			await copyFile(source, destination);
			await chmod(destination, 0o600);
		}
		if (options.modelsFile) {
			const source = await requireFile(options.modelsFile, "Pi models file");
			const destination = join(directory, "models.json");
			await copyFile(source, destination);
			await chmod(destination, 0o600);
		}
		return directory;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

const options = parseAppleContainerEvalArgs(process.argv.slice(2));
for (const name of options.environmentNames) {
	if (process.env[name] === undefined) throw new Error(`Requested container environment is not set: ${name}`);
}
const containerCli = await resolveExecutable(options.containerCli);
const productAgentDir = await requireDirectory(options.productAgentDir ?? defaultProductAgentDir, "Product agent");
await access(resolve(productAgentDir, "runtime/product-config.mjs"), constants.R_OK);
await access(resolve(productAgentDir, "runtime/verify-pi-runtime.mjs"), constants.R_OK);

const artifactDirectory = options.artifactDirectory
	? resolve(options.artifactDirectory)
	: resolve(packageRoot, ".eval", `container_${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`);
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
const resolvedArtifactDirectory = await requireDirectory(artifactDirectory, "Artifact");

const { stdout: versionOutput } = await execFileAsync(containerCli, ["--version"], {
	encoding: "utf8",
	maxBuffer: 1024 * 1024,
});
const containerCliVersion = versionOutput.trim();
if (!containerCliVersion) throw new Error("Apple container CLI returned an empty version.");

if (options.build) {
	const buildStatus = await runStreaming(
		containerCli,
		["build", "--file", resolve(packageRoot, "Containerfile"), "--tag", options.image, packageRoot],
		packageRoot,
	);
	if (buildStatus !== 0) process.exit(buildStatus);
}

const imageDigest = await inspectImage(containerCli, options.image);
const git = await snapshotProductGitIdentity(productAgentDir);
const secretsDirectory = await prepareSecrets(options);
try {
	const runArgs = buildAppleContainerRunArgs(options, {
		productAgentDir,
		artifactDirectory: resolvedArtifactDirectory,
		...(secretsDirectory ? { secretsDirectory } : {}),
		uid: process.getuid?.() ?? 0,
		gid: process.getgid?.() ?? 0,
		containerName: `dev-agent-eval-${randomUUID()}`,
		containerCliVersion,
		imageDigest,
		git,
	});
	console.error(`[container-eval] runtime=${containerCliVersion}`);
	console.error(`[container-eval] image=${options.image}@${imageDigest}`);
	console.error(`[container-eval] product=${productAgentDir} (read-only)`);
	console.error(`[container-eval] artifacts=${resolvedArtifactDirectory}`);
	console.error(`[container-eval] resources=${options.cpus} CPU, ${options.memory} memory, ${options.tmpfs} tmpfs`);
	console.error(`[container-eval] network=${options.network}`);
	console.error(`[container-eval] forwarded-env=${options.environmentNames.join(",") || "none"}`);
	const status = await runStreaming(containerCli, runArgs, packageRoot);
	process.exitCode = status;
} finally {
	if (secretsDirectory) await rm(secretsDirectory, { recursive: true, force: true });
}
