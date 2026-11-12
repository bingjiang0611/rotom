import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const execFile = promisify(execFileCallback);
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(rootDir, "package.json");
export const args = new Set(process.argv.slice(2));

export function getArg(name) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
	return undefined;
}
export async function packageVersion() {
	const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
	if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
		throw new Error(`Could not read package version from ${packageJsonPath}.`);
	}
	return packageJson.version;
}

export async function exists(filePath) {
	try {
		await fs.access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function hashFile(filePath) {
	const data = await fs.readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

export async function run(command, commandArgs) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${commandArgs.join(" ")}`));
		});
	});
}

export async function commandOutput(command, commandArgs) {
	const { stdout } = await execFile(command, commandArgs, { encoding: "utf8" });
	return stdout;
}
