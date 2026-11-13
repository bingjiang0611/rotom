import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("session startup does not request desktop permissions; the first tool call still does", () => {
	const extension = readFileSync(path.join(root, "extensions/computer-use.ts"), "utf8");
	const bridge = readFileSync(path.join(root, "src/bridge.ts"), "utf8");
	const startup = extension.slice(extension.indexOf('pi.on("session_start", async'), extension.indexOf('pi.on("session_shutdown", async'));
	assert.ok(startup.startsWith('pi.on("session_start", async'));
	assert.doesNotMatch(startup, /ensureComputerUseSetup|ensureMacosReady|registerPermissions/);
	assert.match(bridge, /async function executeTool<[\s\S]*?await resourceScheduler\.read\("session-lifecycle", async \(\) => await ensureReady\(ctx, signal\)\)/);
});
