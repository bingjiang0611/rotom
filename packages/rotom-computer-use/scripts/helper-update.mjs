import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import net from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { resolveMacosHelperSocketPath } from "../src/platform/macos/helper-path.mjs";
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
		const finish = (error, result) => {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(new Error(copy.socketUnknown(cmd), { cause: error })); else resolve(result);
		};
		const timer = setTimeout(() => finish(new Error(copy.socketUnknown(cmd))), 2_000);
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify({ id, cmd })}\n`));
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
	if (reply?.shuttingDown !== true) throw new Error(copy.socketUnknown("shutdown"));
	const deadline = Date.now() + 5_000;
	for (;;) {
		const remaining = await runningPids(target, exec);
		if (!remaining.length) return;
		if (Date.now() >= deadline) throw new Error(copy.busy(remaining.join(", ")));
		await delay(100);
	}
}

/**
 * Explicit deployment only. A running helper needs interactive consent to socket shutdown.
 * Never kills a process, creates an identity or launches a helper.
 * The lock serializes this updater; legacy launchers do not participate in it.
 * @param {{source: string, target: string, identity?: string, allowAdhoc?: boolean,
 *   interactive?: boolean, confirmStop?: () => Promise<boolean>, socketPath?: string,
 *   exec?: (command: string, args: string[]) => Promise<{stdout: string, stderr: string}>}} options
 */
export async function updateHelperApp({ source, target, identity, allowAdhoc = false, exec = execute,
	interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), confirmStop = confirmHelperStop,
	socketPath = resolveMacosHelperSocketPath() }) {
	// A refusal must not create a lock, stage files, sign, or send a socket command.
	const lock = `${target}.update-lock`;
	if (await exists(lock)) throw new Error(copy.locked);
	if (await exists(target)) await canonical(target);
	const pids = await runningPids(target, exec);
	if (pids.length && (!interactive || !await confirmStop())) throw new Error(copy.busy(pids.join(", ")));
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
	try {
		await canonical(source);
		const info = await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(source, "Contents", "Info.plist")]);
		if (info.stdout.trim() !== bundleId) throw new Error(copy.wrongBundle);
		await exec("/usr/bin/codesign", ["--verify", "--strict", source]);
		if (pids.length) await stopRunningHelper(target, pids, socketPath, exec);
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
