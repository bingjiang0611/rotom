import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, lstat, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { browserRelayDirectoryV1, browserRelaySocketPathV1 } from "./platform-paths.mjs";
import { createConnection } from "node:net";
import { installer, extensionId, extensionDir, RELAY_ENV, root } from "./chrome-test-paths.mjs";
test("installer 固定组件存储与 exact 注册，status 校验内容且 uninstall 不跟随 symlink", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pi-browser-installer-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	// No directory is pre-created below HOME: the installer must build its own private
	// state root on every platform, and it rejects one it did not create.
	const run = (operation) => spawnSync(process.execPath, [installer, operation], { cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: "utf8" });
	const installed = run("install");
	assert.equal(installed.status, 0, installed.stderr);
	const details = JSON.parse(installed.stdout);
	assert.equal(details.extensionId, extensionId);
	assert.match(details.extensionDir, /\/browser-relay\/current\/chrome-extension$/u);
	assert.equal(details.firstInstall, true);
	assert.equal(await readFile(join(details.extensionDir, "service-worker.js"), "utf8"), await readFile(join(extensionDir, "service-worker.js"), "utf8"));
	const manifestInfo = await lstat(details.nativeHostManifest);
	assert.equal(manifestInfo.isFile() && !manifestInfo.isSymbolicLink() && manifestInfo.nlink === 1, true);
	assert.equal(manifestInfo.mode & 0o077, 0);
	const nativeManifest = JSON.parse(await readFile(details.nativeHostManifest, "utf8"));
	assert.deepEqual(nativeManifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
	assert.equal(nativeManifest.name, "dev.rotom.browser_relay");
	assert.equal(nativeManifest.type, "stdio");
	assert.match(await readFile(nativeManifest.path, "utf8"), /^#!\/bin\/sh\nexec '/u);
	assert.equal(JSON.parse(run("status").stdout).installed, true);
	await writeFile(nativeManifest.path, "tampered\n", { mode: 0o700 });
	assert.equal(JSON.parse(run("status").stdout).installed, false);
	assert.equal(run("install").status, 0, "installer 应可原子修复普通文件内容漂移");
	assert.equal(JSON.parse(run("install").stdout).reloadNeeded, false, "内容未变时重装不要求重新加载");
	assert.equal(run("uninstall").status, 0);
	assert.equal(JSON.parse(run("status").stdout).installed, false);
	assert.equal((await lstat(details.extensionDir)).isDirectory(), true, "uninstall 必须保留可能仍在使用的组件");
	await mkdir(join(home, "outside"));
	const outside = join(home, "outside", "sentinel");
	await writeFile(outside, "keep", { mode: 0o600 });
	await mkdir(browserRelayDirectoryV1({ platform: process.platform, home, env: RELAY_ENV }), { recursive: true, mode: 0o700 });
	const launcher = join(browserRelayDirectoryV1({ platform: process.platform, home, env: RELAY_ENV }), "native-host-launcher.sh");
	await import("node:fs/promises").then(({ symlink }) => symlink(outside, launcher));
	const rejected = run("uninstall");
	assert.notEqual(rejected.status, 0);
	assert.equal(await readFile(outside, "utf8"), "keep");
});
test("Native host 并行 multiplex 多个 Pi client、按 binding 路由响应并隔离断线 cleanup", async (t) => {
	// A short root: the relay socket lives under HOME and must stay within sun_path.
	const home = await mkdtemp("/tmp/pibr-multiplex-");
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(dirname(dirname(browserRelaySocketPathV1({ platform: process.platform, home, env: RELAY_ENV }))), { recursive: true });
	const child = spawn(process.execPath, [join(root, "native-host.mjs")], { env: { ...process.env, HOME: home, ...RELAY_ENV }, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
	t.after(() => { if (child.exitCode === null)
		child.kill("SIGKILL"); });
	const socketPath = browserRelaySocketPathV1({ platform: process.platform, home, env: RELAY_ENV });
	let ready = false;
	for (let attempt = 0; attempt < 1500; attempt += 1) {
		try {
			if ((await lstat(socketPath)).isSocket()) {
				ready = true;
				break;
			}
		}
		catch (error) {
			if (error?.code !== "ENOENT")
				throw error;
		}
		if (child.exitCode !== null)
			break;
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	}
	if (!ready && child.exitCode === 70) {
		t.skip("sandbox 禁止 Native host Unix socket listen");
		return;
	}
	assert.equal(ready, true, `native host exit=${child.exitCode} stderr=${stderr}`);
	const withTimeout = (promise, label, timeoutMs = 1000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs))]);
	const nativeQueue = [];
	const nativeWaiters = [];
	let nativeBuffer = Buffer.alloc(0);
	child.stdout.on("data", (chunk) => {
		nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
		while (nativeBuffer.length >= 4) {
			const size = nativeBuffer.readUInt32LE(0);
			if (nativeBuffer.length < size + 4)
				break;
			const message = JSON.parse(nativeBuffer.subarray(4, size + 4).toString("utf8"));
			nativeBuffer = nativeBuffer.subarray(size + 4);
			const waiter = nativeWaiters.shift();
			if (waiter)
				waiter(message);
			else
				nativeQueue.push(message);
		}
	});
	const nextNative = () => nativeQueue.length ? Promise.resolve(nativeQueue.shift()) : new Promise((resolveMessage) => nativeWaiters.push(resolveMessage));
	const sendNativeResponse = (request, result) => {
		const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "response", id: request.id, sessionId: request.sessionId, generation: request.generation, ok: true, result }), "utf8");
		const header = Buffer.alloc(4);
		header.writeUInt32LE(payload.length, 0);
		child.stdin.write(Buffer.concat([header, payload]));
	};
	const connectClient = async () => {
		const socket = createConnection(socketPath);
		await new Promise((resolveConnected, reject) => { socket.once("connect", resolveConnected); socket.once("error", reject); });
		const queue = [];
		const waiters = [];
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => { buffer += chunk; for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0)
				break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line)
				continue;
			const message = JSON.parse(line);
			const waiter = waiters.shift();
			if (waiter)
				waiter(message);
			else
				queue.push(message);
		} });
		return { socket, send: (message) => socket.write(`${JSON.stringify(message)}\n`), next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolveMessage) => waiters.push(resolveMessage)) };
	};
	const request = (id, sessionId, operation) => ({ schemaVersion: 1, kind: "request", id, sessionId, generation: `generation-${sessionId}`, operation, payload: operation === "hello" ? { nonce: `nonce-${sessionId}` } : {} });
	const readyResult = (sessionId) => ({ schemaVersion: 1, kind: "rotom-browser-relay-ready", protocolRevision: 14, nonce: `nonce-${sessionId}`, capabilities: ["virtualized-frame-scroll", "multi-client-multiplex"] });
	const first = await connectClient();
	const second = await connectClient();
	first.send(request("hello-1", "one", "hello"));
	second.send(request("hello-2", "two", "hello"));
	const firstHello = await withTimeout(nextNative(), "first native hello");
	const secondHello = await withTimeout(nextNative(), "second native hello");
	sendNativeResponse(firstHello, readyResult(firstHello.sessionId));
	sendNativeResponse(secondHello, readyResult(secondHello.sessionId));
	assert.equal((await withTimeout(first.next(), "first hello response")).ok, true);
	assert.equal((await withTimeout(second.next(), "second hello response")).ok, true);
	const probe = await connectClient();
	probe.socket.destroy();
	first.send(request("tabs-1", "one", "tabs"));
	second.send(request("snapshot-2", "two", "snapshot"));
	const firstRequest = await withTimeout(nextNative(), "first parallel request");
	const secondRequest = await withTimeout(nextNative(), "second parallel request");
	sendNativeResponse(secondRequest, { marker: "two" });
	sendNativeResponse(firstRequest, { marker: "one" });
	assert.equal((await withTimeout(second.next(), "second routed response")).result.marker, "two");
	assert.equal((await withTimeout(first.next(), "first routed response")).result.marker, "one");
	second.send(request("wait-2", "two", "wait"));
	const orphanedRequest = await withTimeout(nextNative(), "orphaned native request");
	const secondClosed = new Promise((resolveClosed) => second.socket.once("close", resolveClosed));
	second.socket.destroy();
	await withTimeout(secondClosed, "second client close");
	const disconnectControl = await withTimeout(nextNative(), "session-scoped disconnect control");
	assert.deepEqual({ kind: disconnectControl.kind, operation: disconnectControl.operation, sessionId: disconnectControl.sessionId, generation: disconnectControl.generation }, { kind: "control", operation: "client-disconnected", sessionId: "two", generation: "generation-two" });
	first.send(request("tabs-1b", "one", "tabs"));
	const survivingRequest = await withTimeout(nextNative(), "surviving client request");
	sendNativeResponse(survivingRequest, { marker: "one-still-live" });
	assert.equal((await withTimeout(first.next(), "surviving client response")).result.marker, "one-still-live");
	sendNativeResponse(orphanedRequest, { marker: "dropped-orphan" });
	const third = await connectClient();
	third.send(request("hello-3", "three", "hello"));
	const thirdHello = await withTimeout(nextNative(), "third native hello");
	sendNativeResponse(thirdHello, readyResult("three"));
	assert.equal((await withTimeout(third.next(), "third hello response")).ok, true);
	const firstClosed = new Promise((resolveClosed) => first.socket.once("close", resolveClosed));
	const thirdClosed = new Promise((resolveClosed) => third.socket.once("close", resolveClosed));
	child.stdin.end();
	await withTimeout(new Promise((resolveExit) => child.once("exit", resolveExit)), "native host owner-loss exit", 3000);
	await Promise.all([withTimeout(firstClosed, "first client close"), withTimeout(thirdClosed, "third client close")]);
	await assert.rejects(lstat(socketPath), (error) => error?.code === "ENOENT");
});
