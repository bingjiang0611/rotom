import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import net from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { resolveMacosHelperSocketPath } from "../src/platform/macos/helper-path.mjs";
import { helperUpdateCopy as copy } from "../src/constants/helper-update.mjs";
import { parseCodeSigningIdentities } from "./setup-helper-signing.mjs";
import { hashFile } from "./setup-helper-common.mjs";

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

/** Read-only occupancy probe; an inconclusive lsof result never means stopped. */
async function runningPids(target, exec) {
	const binary = path.join(target, "Contents", "MacOS", "bridge");
	if (!await exists(binary)) return [];
	await canonical(binary);
	let result;
	try { result = await exec("/usr/sbin/lsof", ["-t", "--", binary]); }
	catch (error) {
		if (error.code === 1 && !String(error.stdout ?? "").trim() && !String(error.stderr ?? "").trim()) return [];
		throw new Error(copy.unknownProcesses, { cause: error });
	}
	const pids = result.stdout.trim();
	if (result.stderr.trim() || !/^\d+(?:\s+\d+)*$/.test(pids)) throw new Error(copy.unknownProcesses);
	return pids.split(/\s+/);
}

async function requireStopped(target, exec) {
	const pids = await runningPids(target, exec);
	if (pids.length) throw new Error(copy.busy(pids.join(", ")));
}

/** @param {{input?: import("node:stream").Readable, output?: import("node:stream").Writable}} streams */
export function confirmHelperStop({ input = process.stdin, output = process.stdout } = {}) {
	return new Promise((resolve) => {
		const terminal = createInterface({ input, output });
		terminal.once("close", () => resolve(false));
		terminal.once("SIGINT", () => terminal.close());
		terminal.question(copy.stopPrompt, (answer) => {
			resolve(/^(y|yes|是)$/i.test(answer.trim()));
			terminal.close();
		});
	});
}

/** One socket request, no retries and no helper launch. Missing acknowledgement is unknown. */
async function socketCommand(socketPath, cmd) {
	return await new Promise((resolve, reject) => {
		const id = `helper-update-${cmd}`;
		const socket = net.createConnection(socketPath);
		let buffer = "";
		let dispatched = false;
		const finish = (error, result) => {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(Object.assign(new Error(copy.socketUnknown(cmd), { cause: error }), { unknownWrite: cmd === "shutdown" && dispatched })); else resolve(result);
		};
		const timer = setTimeout(() => finish(new Error(copy.socketUnknown(cmd))), 2_000);
		socket.setEncoding("utf8");
		socket.once("connect", () => {
			dispatched = true;
			socket.write(`${JSON.stringify({ id, cmd })}\n`);
		});
		socket.once("error", (error) => finish(error));
		socket.once("end", () => finish(new Error(copy.socketUnknown(cmd))));
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 65_536) return finish(new Error(copy.socketUnknown(cmd)));
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const reply = JSON.parse(buffer.slice(0, newline));
				if (reply.id !== id || reply.ok !== true) throw new Error(copy.socketUnknown(cmd));
				finish(undefined, reply.result);
			} catch (error) { finish(error); }
		});
	});
}

async function stopRunningHelper(target, pids, socketPath, exec) {
	if (!(await runningPids(target, exec)).length) return;
	const diagnostics = await socketCommand(socketPath, "diagnostics");
	const binary = path.join(target, "Contents", "MacOS", "bridge");
	if (!pids.includes(String(diagnostics?.pid)) || typeof diagnostics?.executablePath !== "string"
		|| await fs.realpath(diagnostics.executablePath) !== binary) throw new Error(copy.socketMismatch);
	const reply = await socketCommand(socketPath, "shutdown");
	try {
		if (reply?.shuttingDown !== true) throw new Error(copy.socketUnknown("shutdown"));
		const deadline = Date.now() + 5_000;
		for (;;) {
			const remaining = await runningPids(target, exec);
			if (!remaining.length) return;
			if (Date.now() >= deadline) throw new Error(copy.busy(remaining.join(", ")));
			await delay(100);
		}
	} catch (error) { throw Object.assign(error, { unknownWrite: true }); }
}

async function installedSignature(target, exec) {
	await canonical(path.join(target, "Contents", "MacOS", "bridge"));
	await canonical(path.join(target, "Contents", "Info.plist"));
	await exec("/usr/bin/codesign", ["--verify", "--strict", target]);
	const result = await exec("/usr/bin/codesign", ["-dv", "--verbose=4", target]);
	const metadata = `${result.stdout}\n${result.stderr}`;
	if (!metadata.split("\n").includes(`Identifier=${bundleId}`)) throw new Error(copy.wrongBundle);
	return metadata;
}

async function sourceHash(app) {
	const file = path.join(app, "Contents", "Resources", "source.sha256");
	if (!await exists(file)) return undefined;
	await canonical(file);
	return (await fs.readFile(file, "utf8")).trim();
}

/**
 * Automatic product synchronization authorizes socket shutdown without another prompt.
 * Explicit manual deployment still asks before stopping a running helper.
 * Never kills a process, creates an identity or launches a helper.
 * The lock serializes this updater; legacy launchers do not participate in it.
 * @param {{source: string, target: string, identity?: string, allowAdhoc?: boolean,
 *   automatic?: boolean, interactive?: boolean, confirmStop?: () => Promise<boolean>, socketPath?: string,
 *   exec?: (command: string, args: string[]) => Promise<{stdout: string, stderr: string}>}} options
 */
export async function updateHelperApp({ source, target, identity, allowAdhoc = false, automatic = false, exec = execute,
	interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), confirmStop = confirmHelperStop,
	socketPath = resolveMacosHelperSocketPath() }) {
	// A refusal must not create a lock, stage files, sign, or send a socket command.
	const lock = `${target}.update-lock`;
	if (await exists(lock)) throw new Error(copy.locked);
	// First use already installs the bundled helper. Synchronization only upgrades an existing install.
	if (automatic && !await exists(target)) return { target, updated: false };
	if (await exists(target)) await canonical(target);
	let signature;
	if (automatic && await exists(target)) {
		signature = await installedSignature(target, exec);
		await canonical(source);
		const sourceBinary = path.join(source, "Contents", "MacOS", "bridge");
		await canonical(sourceBinary);
		const desired = await hashFile(sourceBinary);
		const sourceInfo = path.join(source, "Contents", "Info.plist");
		await canonical(sourceInfo);
		const sameInfo = (await fs.readFile(sourceInfo)).equals(await fs.readFile(path.join(target, "Contents", "Info.plist")));
		if (desired === await sourceHash(target) && sameInfo) return { target, updated: false };
	}
	const pids = await runningPids(target, exec);
	if (pids.length && !automatic && (!interactive || !await confirmStop())) throw new Error(copy.busy(pids.join(", ")));
	const parent = path.dirname(target);
	if (!await exists(parent)) {
		await canonical(path.dirname(parent));
		await fs.mkdir(parent, { mode: 0o700 });
	}
	await canonical(parent);
	if (await exists(target)) await canonical(target);
	try { await fs.mkdir(lock, { mode: 0o700 }); }
	catch (error) { if (error.code === "EEXIST") throw new Error(copy.locked); throw error; }
	let staging;
	let previousMoved = false;
	let installed = false;
	let preserveLock = false;
	try {
		await canonical(source);
		const info = await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(source, "Contents", "Info.plist")]);
		if (info.stdout.trim() !== bundleId) throw new Error(copy.wrongBundle);
		await exec("/usr/bin/codesign", ["--verify", "--strict", source]);
		if (automatic && signature) {
			allowAdhoc = /^Signature=adhoc$/m.test(signature);
			if (!allowAdhoc && !identity) {
				const authority = signature.match(/^Authority=(.+)$/m)?.[1];
				const identities = await exec("/usr/bin/security", ["find-identity", "-p", "codesigning", "-v"]);
				const matches = authority ? parseCodeSigningIdentities(identities.stdout, authority) : [];
				if (matches.length !== 1) throw new Error(copy.signerUnavailable);
				identity = matches[0];
			}
		}
		staging = await fs.mkdtemp(path.join(parent, ".pi-computer-use-update-"));
		const candidate = path.join(staging, "pi-computer-use.app");
		await exec("/usr/bin/ditto", [source, candidate]);
		const signingIdentity = identity || (automatic ? "-" : undefined);
		if (signingIdentity) {
			// Reuse the installer's sealed source-binary stamp; re-signing changes Mach-O bytes.
			const resources = path.join(candidate, "Contents", "Resources");
			await fs.mkdir(resources, { recursive: true });
			await fs.writeFile(path.join(resources, "source.sha256"), `${await hashFile(path.join(candidate, "Contents", "MacOS", "bridge"))}\n`);
			await exec("/usr/bin/codesign", ["--force", "--deep", "--timestamp=none", "--identifier", bundleId, "--sign", signingIdentity, candidate]);
		}
		await exec("/usr/bin/codesign", ["--verify", "--strict", candidate]);
		const candidateSignature = await exec("/usr/bin/codesign", ["-dv", "--verbose=4", candidate]);
		const metadata = `${candidateSignature.stdout}\n${candidateSignature.stderr}`;
		if (!metadata.split("\n").includes(`Identifier=${bundleId}`)) throw new Error(copy.wrongBundle);
		if (await exists(target) && /^Signature=adhoc$/m.test(metadata) && !allowAdhoc) throw new Error(automatic ? copy.automaticAdhoc : copy.adhoc);
		// Prepare and verify before stopping anything: signing failures leave the old helper running.
		if (pids.length) await stopRunningHelper(target, pids, socketPath, exec);
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
		return { target, signed: Boolean(identity), updated: true };
	} catch (error) {
		// A later automatic startup must not replay an uncertain shutdown or replacement.
		preserveLock = error.unknownWrite === true || (previousMoved && !installed);
		throw error;
	} finally {
		// Preserve the previous app if the replacement failed; do not guess or replay a write.
		try { if (staging && (!previousMoved || installed)) await fs.rm(staging, { recursive: true, force: true }); }
		finally { if (!preserveLock) await fs.rmdir(lock); }
	}
}
