import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const hostPath = resolve("rotom/extensions/browser/native-host.mjs");

async function fixture(t) {
	// Keep Unix socket paths within the platform's sun_path limit.
	const home = await mkdtemp("/tmp/rotom-host-");
	await mkdir(join(home, "Library", "Application Support"), { recursive: true });
	const socketPath = join(home, "Library", "Application Support", "rotom", "browser-relay", "relay.sock");
	const hosts = [];
	t.after(async () => {
		for (const host of hosts) {
			if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGKILL");
			await host.closed;
		}
		await rm(home, { recursive: true, force: true });
	});
	const start = () => {
		const child = spawn(process.execPath, [hostPath], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
		child.stderr.resume();
		const host = { child, closed: once(child, "close") };
		hosts.push(host);
		return host;
	};
	const ready = async (host, previousInode) => {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			assert.equal(host.child.exitCode, null, "host exited before listening");
			try {
				const info = await lstat(socketPath);
				if (info.isSocket() && info.ino !== previousInode) {
					const socket = createConnection(socketPath);
					try { await once(socket, "connect"); return info; }
					finally { socket.destroy(); }
				}
			} catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error; }
			await delay(10);
		}
		assert.fail("host did not publish its socket");
	};
	const roundTrip = async (host) => {
		const socket = createConnection(socketPath);
		t.after(() => socket.destroy());
		await once(socket, "connect");
		const request = { schemaVersion: 1, kind: "request", id: "hello", sessionId: "fixture", generation: "one", operation: "hello", payload: {} };
		const forwarded = once(host.child.stdout, "data");
		socket.write(`${JSON.stringify(request)}\n`);
		let [frame] = await forwarded;
		while (frame.length < 4 || frame.length < frame.readUInt32LE(0) + 4) {
			const [chunk] = await once(host.child.stdout, "data");
			frame = Buffer.concat([frame, chunk]);
		}
		assert.deepEqual(JSON.parse(frame.subarray(4).toString()), request);
		const response = { ...request, kind: "response", ok: true, result: { alive: true } };
		const payload = Buffer.from(JSON.stringify(response));
		const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
		const received = once(socket, "data");
		host.child.stdin.write(Buffer.concat([header, payload]));
		let [line] = await received;
		while (!line.includes(10)) {
			const [chunk] = await once(socket, "data");
			line = Buffer.concat([line, chunk]);
		}
		assert.deepEqual(JSON.parse(line.toString()), response);
		socket.destroy();
	};
	return { socketPath, start, ready, roundTrip };
}

test("duplicate native host cannot unlink the live owner's socket", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	const owner = f.start(); const identity = await f.ready(owner);
	const duplicate = f.start();
	assert.deepEqual(await duplicate.closed, [70, null]);
	assert.equal(owner.child.exitCode, null);
	assert.equal((await lstat(f.socketPath)).ino, identity.ino);
	await f.roundTrip(owner);
});

test("native host reclaims a refused stale socket and cleans its own socket on EOF", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	const crashed = f.start(); await f.ready(crashed);
	crashed.child.kill("SIGKILL"); await crashed.closed;
	assert.equal((await lstat(f.socketPath)).isSocket(), true);
	const owner = f.start();
	// The filesystem may reuse the dead owner's inode. Readiness must prove a
	// connection, and the round trip proves which process owns that connection.
	await f.ready(owner);
	await f.roundTrip(owner);
	owner.child.stdin.end(); assert.deepEqual(await owner.closed, [0, null]);
	await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
});

for (const shutdown of ["EOF", "SIGTERM"]) {
	test(`retired native host preserves a successor socket on ${shutdown}`, { timeout: 10_000 }, async (t) => {
		const f = await fixture(t);
		const retired = f.start(); const identity = await f.ready(retired);
		await rm(f.socketPath);
		const successor = f.start(); const next = await f.ready(successor, identity.ino);
		if (shutdown === "EOF") retired.child.stdin.end(); else retired.child.kill(shutdown);
		assert.deepEqual(await retired.closed, [0, null]);
		assert.equal((await lstat(f.socketPath)).ino, next.ino);
		await f.roundTrip(successor);
	});
}
