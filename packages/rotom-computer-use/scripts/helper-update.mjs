import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { helperUpdateCopy as copy } from "../src/constants/helper-update.mjs";

const execFile = promisify(execFileCallback);
const bundleId = "com.injaneity.pi-computer-use";
const execute = (command, args) => execFile(command, args, { encoding: "utf8", timeout: 30_000 });

async function exists(file) {
	try { await fs.lstat(file); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function canonical(file) {
	if (await fs.realpath(file) !== file) throw new Error(copy.unsafePath);
}

/** Refuse even an idle helper or another process holding its executable open. */
async function requireStopped(target, exec) {
	const binary = path.join(target, "Contents", "MacOS", "bridge");
	if (!await exists(binary)) return;
	await canonical(binary);
	let result;
	try { result = await exec("/usr/sbin/lsof", ["-t", "--", binary]); }
	catch (error) {
		// lsof documents 1 for no selection. Other failures/warnings are not proof of idleness.
		if (error.code === 1 && !String(error.stdout ?? "").trim() && !String(error.stderr ?? "").trim()) return;
		throw new Error(copy.unknownProcesses, { cause: error });
	}
	const pids = result.stdout.trim();
	if (!/^\d+(?:\s+\d+)*$/.test(pids)) throw new Error(copy.unknownProcesses);
	throw new Error(copy.busy(pids.replace(/\s+/g, ", ")));
}

/**
 * Explicit deployment only. No process termination, identity creation or helper launch.
 * The lock serializes this updater; legacy launchers do not participate in it.
 * @param {{source: string, target: string, identity?: string, allowAdhoc?: boolean,
 *   exec?: (command: string, args: string[]) => Promise<{stdout: string, stderr: string}>}} options
 */
export async function updateHelperApp({ source, target, identity, allowAdhoc = false, exec = execute }) {
	const parent = path.dirname(target);
	if (!await exists(parent)) {
		await canonical(path.dirname(parent));
		await fs.mkdir(parent, { mode: 0o700 });
	}
	await canonical(parent);
	if (await exists(target)) await canonical(target);
	const lock = `${target}.update-lock`;
	try { await fs.mkdir(lock, { mode: 0o700 }); }
	catch (error) { if (error.code === "EEXIST") throw new Error(copy.locked); throw error; }
	let staging;
	let previousMoved = false;
	let installed = false;
	try {
		await requireStopped(target, exec);
		await canonical(source);
		const info = await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(source, "Contents", "Info.plist")]);
		if (info.stdout.trim() !== bundleId) throw new Error(copy.wrongBundle);
		await exec("/usr/bin/codesign", ["--verify", "--strict", source]);
		staging = await fs.mkdtemp(path.join(parent, ".pi-computer-use-update-"));
		const candidate = path.join(staging, "pi-computer-use.app");
		await exec("/usr/bin/ditto", [source, candidate]);
		if (identity) {
			await exec("/usr/bin/codesign", ["--force", "--deep", "--timestamp=none", "--identifier", bundleId, "--sign", identity, candidate]);
		}
		await exec("/usr/bin/codesign", ["--verify", "--strict", candidate]);
		const signature = await exec("/usr/bin/codesign", ["-dv", "--verbose=4", candidate]);
		const metadata = `${signature.stdout}\n${signature.stderr}`;
		if (!metadata.split("\n").includes(`Identifier=${bundleId}`)) throw new Error(copy.wrongBundle);
		if (await exists(target) && /^Signature=adhoc$/m.test(metadata) && !allowAdhoc) throw new Error(copy.adhoc);
		// Staging/signing can take time. Check again immediately before the path replacement.
		await requireStopped(target, exec);
		const backup = path.join(staging, "previous.app");
		if (await exists(target)) {
			await fs.rename(target, backup);
			previousMoved = true;
		}
		try { await fs.rename(candidate, target); }
		catch (error) { throw new Error(previousMoved ? copy.incomplete(backup) : copy.notInstalled, { cause: error }); }
		installed = true;
		return { target, signed: Boolean(identity) };
	} finally {
		// Preserve the previous app if the replacement failed; do not guess or replay a write.
		try { if (staging && (!previousMoved || installed)) await fs.rm(staging, { recursive: true, force: true }); }
		finally { await fs.rmdir(lock); }
	}
}
