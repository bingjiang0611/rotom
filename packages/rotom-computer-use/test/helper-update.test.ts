import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import net from "node:net";
import { updateHelperApp } from "../scripts/helper-update.mjs";
import { macosSourceFiles } from "../scripts/macos-sources.mjs";
import { helperMismatchMessage } from "../src/constants/copy.ts";

const identifier = "com.injaneity.pi-computer-use";
async function fixture() {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "cu-update-test-")));
	const source = path.join(root, "source.app");
	const target = path.join(root, "Applications/pi-computer-use.app");
	for (const [app, contents] of [[source, "new"], [target, "old"]]) {
		await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
		await writeFile(path.join(app, "Contents/MacOS/bridge"), contents);
		await writeFile(path.join(app, "Contents/Info.plist"), identifier);
		await mkdir(path.join(app, "Contents/Resources"));
		await writeFile(path.join(app, "Contents/Resources/source.sha256"), contents);
	}
	const calls: Array<{ command: string; args: string[] }> = [];
	const state = { running: false, busyAt: 0, checks: 0, signed: "", adhoc: true, failSign: false, failVerify: false, processUnknown: false, identities: `1) ${"A".repeat(40)} "Fixture Identity"` };
	const exec = async (command: string, args: string[]) => {
		calls.push({ command, args });
		if (command.endsWith("lsof")) {
			state.checks++;
			if (state.processUnknown) throw Object.assign(new Error("probe failed"), { code: 1, stderr: "permission denied" });
			if (state.running || state.checks === state.busyAt) return { stdout: "12345\n", stderr: "" };
			throw Object.assign(new Error("no selection"), { code: 1, stdout: "", stderr: "" });
		}
		if (command.endsWith("plutil")) return { stdout: identifier, stderr: "" };
		if (command.endsWith("security")) return { stdout: state.identities, stderr: "" };
		if (command.endsWith("ditto")) await cp(args[0], args[1], { recursive: true });
		else if (command.endsWith("codesign")) {
			if (args.includes("--sign")) {
				if (state.failSign) throw new Error("signing rejected");
				assert.equal(args[args.indexOf("--identifier") + 1], identifier);
				assert.notEqual(args.at(-1), source);
				assert.notEqual(args.at(-1), target);
				state.signed = args[args.indexOf("--sign") + 1];
			}
			if (args.includes("--verify") && args.at(-1) !== source && state.failVerify) throw new Error("invalid sealed bundle");
			if (args.includes("-dv")) return { stdout: "", stderr: `Identifier=${identifier}\n${state.signed === "-" || (state.adhoc && !state.signed) ? "Signature=adhoc" : "Authority=Fixture Identity"}\n` };
		} else assert.fail(`Unexpected command: ${command}`);
		return { stdout: "", stderr: "" };
	};
	return { root, source, target, state, calls, exec };
}

// Real socket framing, but a disposable fake helper: never a daily helper socket.
async function helperSocket(f: Awaited<ReturnType<typeof fixture>>, mode: "stop" | "wrong-target" | "lost-ack" | "still-busy") {
	const socketPath = path.join(f.root, "helper.sock");
	const commands: string[] = [];
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			const request = JSON.parse(buffer.split("\n")[0]);
			commands.push(request.cmd);
			if (request.cmd === "diagnostics") {
				socket.end(JSON.stringify({ id: request.id, ok: true, result: { pid: 12345,
					executablePath: path.join(mode === "wrong-target" ? f.source : f.target, "Contents/MacOS/bridge") } }) + "\n");
			} else {
				assert.equal(request.cmd, "shutdown");
				if (mode === "lost-ack") { socket.end(); return; }
				if (mode === "stop") f.state.running = false;
				socket.end(JSON.stringify({ id: request.id, ok: true, result: { shuttingDown: true } }) + "\n");
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
	return { socketPath, commands, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

for (const interactive of [true, false]) test(`busy refusal leaves files and socket untouched (interactive=${interactive})`, async () => {
	const f = await fixture();
	f.state.running = true;
	const socket = await helperSocket(f, "stop");
	let asked = 0;
	try {
		await assert.rejects(updateHelperApp({ ...f, socketPath: socket.socketPath, interactive,
			confirmStop: async () => { asked++; return false; } }), /still in use/);
		assert.equal(asked, interactive ? 1 : 0);
		assert.deepEqual(socket.commands, []);
		assert.deepEqual(f.calls.map(c => path.basename(c.command)), ["lsof"]);
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "old");
		assert.deepEqual(await readdir(path.dirname(f.target)), ["pi-computer-use.app"]);
	} finally { await socket.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("consent prepares and signs first, then shuts down once and waits before replacement", async () => {
	const f = await fixture();
	f.state.running = true;
	const socket = await helperSocket(f, "stop");
	let holdProbes = 2, asked = 0;
	const exec = async (command: string, args: string[]) => {
		if (command.endsWith("lsof") && socket.commands.includes("shutdown") && holdProbes-- > 0) return { stdout: "12345\n", stderr: "" };
		if (command.endsWith("ditto")) {
			assert.deepEqual(socket.commands, []);
			assert.equal(f.state.running, true, "prepare before interrupting the old helper");
		}
		return await f.exec(command, args);
	};
	try {
		await updateHelperApp({ ...f, exec, identity: "Approved Identity", interactive: true, socketPath: socket.socketPath,
			confirmStop: async () => { asked++; assert.deepEqual(socket.commands, []); return true; } });
		assert.equal(asked, 1);
		assert.ok(holdProbes < 0, "must observe an unoccupied executable, not just a shutdown ack");
		assert.deepEqual(socket.commands, ["diagnostics", "shutdown"]);
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "new");
		assert.equal(await readFile(path.join(f.source, "Contents/MacOS/bridge"), "utf8"), "new");
	} finally { await socket.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const mode of ["wrong-target", "lost-ack", "still-busy"] as const) test(`shutdown gate refuses ${mode} without replacement or replay`, async () => {
	const f = await fixture();
	f.state.running = true;
	const socket = await helperSocket(f, mode);
	try {
		await assert.rejects(updateHelperApp({ ...f, identity: "Approved Identity", interactive: true,
			socketPath: socket.socketPath, confirmStop: async () => true }),
			mode === "wrong-target" ? /does not identify/ : mode === "lost-ack" ? /unknown/ : /still in use/);
		assert.deepEqual(socket.commands, mode === "wrong-target" ? ["diagnostics"] : ["diagnostics", "shutdown"]);
		assert.ok(f.calls.some(c => c.args.includes("--sign")), "candidate is prepared before shutdown");
		if (mode !== "wrong-target") {
			await assert.rejects(updateHelperApp({ ...f, automatic: true }), /another update|lock/i);
			assert.deepEqual(socket.commands, ["diagnostics", "shutdown"], "unknown shutdown is never replayed");
		}
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "old");
	} finally { await socket.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const busyAt of [1, 2]) test(`update refuses a busy helper at process check ${busyAt}`, async () => {
	const f = await fixture();
	try {
		f.state.busyAt = busyAt;
		await assert.rejects(updateHelperApp({ ...f, identity: "Approved Identity" }), /still in use.*12345/);
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "old");
		if (busyAt === 1) assert.deepEqual(f.calls.map(call => path.basename(call.command)), ["lsof"]);
		assert.deepEqual(await readdir(path.dirname(f.target)), ["pi-computer-use.app"]);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("process-check uncertainty is not treated as an idle helper", async () => {
	const f = await fixture();
	try {
		f.state.processUnknown = true;
		await assert.rejects(updateHelperApp({ ...f, identity: "Approved Identity" }), /Cannot establish/);
		assert.equal(f.calls.length, 1);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("explicit identity signs only the staged copy, verifies it and installs without launch", async () => {
	const f = await fixture();
	try {
		const result = await updateHelperApp({ ...f, identity: "Approved Identity" });
		assert.equal(result.signed, true);
		assert.equal(f.state.signed, "Approved Identity");
		assert.equal(await readFile(path.join(f.source, "Contents/MacOS/bridge"), "utf8"), "new");
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "new");
		assert.equal(f.state.checks, 2);
		assert.equal(f.calls.filter(call => call.args.includes("--verify")).length, 2);
		assert.deepEqual(await readdir(path.dirname(f.target)), ["pi-computer-use.app"]);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const failure of ["failSign", "failVerify"] as const) test(`${failure} preserves the old helper`, async () => {
	const f = await fixture();
	try {
		f.state[failure] = true;
		await assert.rejects(updateHelperApp({ ...f, identity: "Approved Identity" }), /rejected|invalid sealed/);
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "old");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("no identity preserves the original signature and the ad-hoc replacement guard", async () => {
	const f = await fixture();
	try {
		await assert.rejects(updateHelperApp(f), /ad-hoc bundle/);
		assert.equal(f.state.signed, "");
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "old");
		f.state.adhoc = false;
		await updateHelperApp(f);
		assert.equal(f.state.signed, "");
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "new");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("explicit ad-hoc opt-in retains its existing meaning, without re-signing", async () => {
	const f = await fixture();
	try {
		await updateHelperApp({ ...f, allowAdhoc: true });
		assert.equal(f.state.signed, "");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("real lsof detects a held fixture executable without executing any helper", { skip: process.platform !== "darwin" }, async () => {
	const f = await fixture();
	const held = await open(path.join(f.target, "Contents/MacOS/bridge"));
	try {
		await assert.rejects(updateHelperApp({ source: f.source, target: f.target, identity: "unused" }), /still in use/);
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "old");
	} finally { await held.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an existing update lock and a symlink target both fail before staging", async () => {
	const f = await fixture();
	try {
		await mkdir(`${f.target}.update-lock`);
		await assert.rejects(updateHelperApp(f), /update is in progress/);
		await rm(`${f.target}.update-lock`, { recursive: true });
		await rm(f.target, { recursive: true });
		await symlink(f.source, f.target);
		await assert.rejects(updateHelperApp(f), /non-canonical/);
		assert.equal(f.calls.length, 0);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("packaged updater signs and installs only in an isolated HOME, without launching a helper", { skip: process.platform !== "darwin" }, async () => {
	const f = await fixture();
	try {
		const home = path.join(f.root, "home");
		const unpacked = path.join(f.root, "unpacked");
		await mkdir(home);
		await mkdir(unpacked);
		const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		const archive = path.resolve(import.meta.dirname, `../../../rotom/extensions/third-party/vendor/injaneity-pi-computer-use-${version}.tgz`);
		execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
		const packagedApp = path.join(unpacked, "package/prebuilt/macos/universal/pi-computer-use.app");
		const binary = "Contents/MacOS/bridge";
		const before = await readFile(path.join(packagedApp, binary));
		const target = path.join(home, "Applications/pi-computer-use.app");
		const env = { ...process.env, HOME: home, PI_COMPUTER_USE_HELPER_APP_PATH: path.join(home, "ignored.app"), PI_COMPUTER_USE_CODESIGN_IDENTITY: "-", PI_COMPUTER_USE_NO_SIGN: "0", PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE: "0" };
		const command = [path.join(unpacked, "package/scripts/setup-helper.mjs"), "--update"];
		const result = spawnSync(process.execPath, command, { env, encoding: "utf8", timeout: 60_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /No helper was started/);
		execFileSync("/usr/bin/codesign", ["--verify", "--strict", target]);
		const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", target], { encoding: "utf8" });
		assert.equal(signature.status, 0);
		assert.match(signature.stderr, /Identifier=com\.injaneity\.pi-computer-use/);
		assert.match(signature.stderr, /Signature=adhoc/);
		assert.deepEqual(await readFile(path.join(packagedApp, binary)), before);
		assert.deepEqual(await readdir(home), ["Applications"]);
		const installed = await readFile(path.join(target, binary));
		const unchanged = spawnSync(process.execPath, command, { env: { ...env, PI_COMPUTER_USE_CODESIGN_IDENTITY: "" }, encoding: "utf8", timeout: 60_000 });
		assert.equal(unchanged.status, 1);
		assert.match(unchanged.stderr, /ad-hoc bundle/);
		assert.deepEqual(await readFile(path.join(target, binary)), installed);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("automatic upgrade reuses the installed signer and stops without a terminal prompt", async () => {
	const f = await fixture();
	f.state.adhoc = false;
	f.state.running = true;
	const socket = await helperSocket(f, "stop");
	try {
		const result = await updateHelperApp({ ...f, automatic: true, interactive: false,
			socketPath: socket.socketPath, confirmStop: async () => assert.fail("must not ask") });
		assert.equal(result.updated, true);
		assert.equal(f.state.signed, "A".repeat(40));
		assert.deepEqual(socket.commands, ["diagnostics", "shutdown"]);
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "new");
		const calls = f.calls.length;
		assert.equal((await updateHelperApp({ ...f, automatic: true })).updated, false);
		assert.deepEqual(f.calls.slice(calls).map(c => path.basename(c.command)), ["codesign", "codesign"]);
		assert.deepEqual(socket.commands, ["diagnostics", "shutdown"], "current helper is never stopped again");
	} finally { await socket.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const failure of ["missing", "ambiguous", "signing"] as const) test(`automatic ${failure} signing failure leaves old helper running`, async () => {
	const f = await fixture();
	f.state.adhoc = false; f.state.running = true;
	if (failure === "missing") f.state.identities = "";
	if (failure === "ambiguous") f.state.identities += `\n2) ${"B".repeat(40)} "Fixture Identity"`;
	if (failure === "signing") f.state.failSign = true;
	const socket = await helperSocket(f, "stop");
	try {
		await assert.rejects(updateHelperApp({ ...f, automatic: true, socketPath: socket.socketPath }), /identity|signing rejected/);
		assert.deepEqual(socket.commands, []);
		assert.equal(f.state.running, true);
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "old");
	} finally { await socket.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("automatic synchronization preserves ad-hoc trust and does not provision an unused helper", async () => {
	const f = await fixture();
	try {
		assert.equal((await updateHelperApp({ ...f, automatic: true })).updated, true);
		assert.equal(f.calls.some(c => c.command.endsWith("security")), false);
		assert.equal(f.state.signed, "-", "the source stamp is sealed without elevating ad-hoc trust");
		await rm(f.target, { recursive: true });
		f.calls.length = 0;
		assert.equal((await updateHelperApp({ ...f, automatic: true })).updated, false);
		assert.deepEqual(f.calls, []);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("automatic synchronization cannot downgrade a certificate-signed helper, even with a legacy ad-hoc opt-in", async () => {
	const f = await fixture();
	f.state.adhoc = false; f.state.running = true;
	const socket = await helperSocket(f, "stop");
	try {
		await assert.rejects(updateHelperApp({ ...f, automatic: true, identity: "-", allowAdhoc: true, socketPath: socket.socketPath }), /will not replace a certificate-signed helper/);
		assert.deepEqual(socket.commands, []);
		assert.equal(f.state.running, true);
		assert.equal(await readFile(path.join(f.target, "Contents/MacOS/bridge"), "utf8"), "old");
	} finally { await socket.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("automatic synchronization checks bundle metadata even when native bytes match", async () => {
	const f = await fixture();
	try {
		await updateHelperApp({ ...f, automatic: true });
		await writeFile(path.join(f.source, "Contents/Info.plist"), `${identifier}\nchanged metadata`);
		assert.equal((await updateHelperApp({ ...f, automatic: true })).updated, true);
		assert.equal(await readFile(path.join(f.target, "Contents/Info.plist"), "utf8"), `${identifier}\nchanged metadata`);
		const exec = async (command: string, args: string[]) => args.includes("-dv")
			? { stdout: "", stderr: "Identifier=unexpected.app\nSignature=adhoc\n" } : await f.exec(command, args);
		await assert.rejects(updateHelperApp({ ...f, exec, automatic: true }), /unexpected bundle/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("both native build paths consume the same complete Swift list", async () => {
	assert.equal(new Set(macosSourceFiles).size, macosSourceFiles.length);
	for (const file of macosSourceFiles) await readFile(new URL(`../native/macos/${file}`, import.meta.url));
	for (const file of ["input_source.swift", "takeover_state.swift", "takeover_border.swift", "takeover_state_test.swift", "text_outcome.swift"]) assert.ok(macosSourceFiles.includes(file));
	for (const name of ["build-native.mjs", "setup-helper.mjs"]) {
		const source = await readFile(new URL(`../scripts/${name}`, import.meta.url), "utf8");
		assert.match(source, /import \{ macosSourceFiles \} from "\.\/macos-sources\.mjs"/);
		assert.match(source, /macosSourceFiles\s*\.map\(\(file\) => path.join\(rootDir, "native", "macos", file\)\)/);
		assert.doesNotMatch(source, /"[a-z_]+\.swift"/);
	}
	const message = helperMismatchMessage(11, "expected", 8, "old");
	assert.match(message, /rotom helper update/);
	assert.match(message, /PI_COMPUTER_USE_CODESIGN_IDENTITY/);
	assert.match(message, /was not restarted/);
});
