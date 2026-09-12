#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";

const SCHEMA_VERSION = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const relayDir = join(homedir(), "Library", "Application Support", "rotom", "browser-relay");
const socketPath = join(relayDir, "relay.sock");
let nativeBuffer = Buffer.alloc(0);
const clients = new Set();
const clientBuffers = new Map();
const clientBindings = new Map();
const pendingRoutes = new Map();
let stdoutChain = Promise.resolve();

function ensurePrivateDirectory(path) {
	if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error(`browser relay private directory 无效：${path}`);
}

function setupDirectories() {
	const applicationSupport = join(homedir(), "Library", "Application Support");
	if (!existsSync(applicationSupport) || !lstatSync(applicationSupport).isDirectory()) throw new Error("Application Support 目录不存在");
	ensurePrivateDirectory(join(applicationSupport, "rotom"));
	ensurePrivateDirectory(relayDir);
}

function routeKey(message) {
	return `${message.sessionId}\0${message.generation}\0${message.id}`;
}

function encodeClientMessage(message) {
	const payload = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(payload, "utf8") > MAX_MESSAGE_BYTES) throw new Error("native message 超过 1 MiB");
	return payload;
}

function sendNative(message) {
	const payload = Buffer.from(JSON.stringify(message), "utf8");
	if (payload.length > MAX_MESSAGE_BYTES) throw new Error("native response 超过 1 MiB");
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(payload.length, 0);
	const frame = Buffer.concat([header, payload]);
	stdoutChain = stdoutChain.then(() => new Promise((resolve, reject) => {
		process.stdout.write(frame, (error) => error ? reject(error) : resolve());
	}));
	stdoutChain.catch(() => process.exit(72));
}

function sendDirect(client, message, onFlushed) {
	if (client.destroyed) { onFlushed?.(new Error("browser relay client is closed")); return; }
	client.write(encodeClientMessage(message), (error) => onFlushed?.(error));
}

function completeRoute(key) {
	pendingRoutes.delete(key);
}

function onNativeMessage(message) {
	if (!message || typeof message !== "object" || message.schemaVersion !== SCHEMA_VERSION || message.kind !== "response" || typeof message.id !== "string" || typeof message.sessionId !== "string" || typeof message.generation !== "string") throw new Error("native message schema 无效");
	const key = routeKey(message);
	const route = pendingRoutes.get(key);
	if (!route) return;
	if (route.client.destroyed) { completeRoute(key); return; }
	sendDirect(route.client, message, (error) => {
		completeRoute(key);
		if (error && !route.client.destroyed) route.client.destroy(error);
	});
}

function parseNativeFrames(chunk) {
	nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
	if (nativeBuffer.length > MAX_MESSAGE_BYTES * 2) throw new Error("native input buffer 超限");
	while (nativeBuffer.length >= 4) {
		const size = nativeBuffer.readUInt32LE(0);
		if (size < 2 || size > MAX_MESSAGE_BYTES) throw new Error("native frame size 无效");
		if (nativeBuffer.length < size + 4) return;
		const payload = nativeBuffer.subarray(4, size + 4);
		nativeBuffer = nativeBuffer.subarray(size + 4);
		onNativeMessage(JSON.parse(payload.toString("utf8")));
	}
}

function forwardClientMessage(client, message) {
	if (!message || typeof message !== "object" || message.schemaVersion !== SCHEMA_VERSION || message.kind !== "request" || typeof message.id !== "string" || typeof message.sessionId !== "string" || typeof message.generation !== "string" || typeof message.operation !== "string") throw new Error("browser relay client message 无效");
	const binding = clientBindings.get(client);
	if (!binding) {
		if (message.operation !== "hello") throw new Error("browser relay client must bind with hello");
		clientBindings.set(client, { sessionId: message.sessionId, generation: message.generation });
	} else if (binding.sessionId !== message.sessionId || binding.generation !== message.generation) throw new Error("browser relay client binding changed");
	const key = routeKey(message);
	if (pendingRoutes.has(key)) throw new Error("browser relay duplicate request identity");
	pendingRoutes.set(key, { client });
	try { sendNative(message); }
	catch (error) { pendingRoutes.delete(key); throw error; }
}

function parseClientLines(client, chunk) {
	let buffer = `${clientBuffers.get(client) ?? ""}${chunk}`;
	if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES * 2) throw new Error("browser relay client buffer 超限");
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		forwardClientMessage(client, JSON.parse(line));
	}
	clientBuffers.set(client, buffer);
}

function cleanupClient(client) {
	clients.delete(client);
	clientBuffers.delete(client);
	const binding = clientBindings.get(client);
	clientBindings.delete(client);
	if (!binding) return;
	try { sendNative({ schemaVersion: 1, kind: "control", operation: "client-disconnected", sessionId: binding.sessionId, generation: binding.generation }); }
	catch { /* native channel may already be gone */ }
}

function cleanupSocket() {
	try {
		if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
	} catch { /* process exit cleanup is best effort; next start validates stale socket */ }
}

async function listen(server) {
	await new Promise((resolve, reject) => {
		const onError = (error) => { server.off("listening", onListening); reject(error); };
		const onListening = () => { server.off("error", onError); resolve(); };
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

async function socketIsLive() {
	return new Promise((resolve) => {
		const client = createConnection(socketPath);
		const timer = setTimeout(() => { client.destroy(); resolve(false); }, 500);
		client.once("connect", () => { clearTimeout(timer); client.destroy(); resolve(true); });
		client.once("error", () => { clearTimeout(timer); resolve(false); });
	});
}

async function main() {
	setupDirectories();
	const server = createServer((client) => {
		clients.add(client);
		clientBuffers.set(client, "");
		client.setEncoding("utf8");
		client.on("data", (chunk) => {
			try { parseClientLines(client, chunk); }
			catch (error) { client.destroy(error instanceof Error ? error : new Error(String(error))); }
		});
		client.on("error", () => { /* isolate malformed or failed clients; close performs scoped cleanup */ });
		client.on("close", () => cleanupClient(client));
	});
	try {
		await listen(server);
	} catch (error) {
		if (error?.code !== "EADDRINUSE") throw error;
		if (await socketIsLive()) throw new Error("另一个 browser relay native host 已运行");
		const info = lstatSync(socketPath);
		if (!info.isSocket() || info.isSymbolicLink()) throw new Error("browser relay stale path 不是 socket");
		unlinkSync(socketPath);
		await listen(server);
	}
	server.on("error", () => process.exit(73));
	chmodSync(socketPath, 0o600);
	process.stdin.on("data", (chunk) => {
		try { parseNativeFrames(chunk); }
		catch { process.exit(74); }
	});
	process.stdin.on("end", () => {
		for (const client of clients) client.destroy(new Error("Chrome native channel closed"));
		cleanupSocket();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 1_000).unref();
	});
	process.stdin.resume();
}

process.once("exit", cleanupSocket);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => { cleanupSocket(); process.exit(0); });

main().catch(() => process.exit(70));
