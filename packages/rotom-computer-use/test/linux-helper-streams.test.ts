import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LinuxHelperClient } from "../src/platform/linux/helper.ts";

const isError = (error: unknown): boolean => error instanceof Error;

// The setup script runs under `node`, so a no-op must be JavaScript.
async function noopSetup(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "cu-linux-setup-"));
	const file = path.join(dir, "setup-helper.mjs");
	await writeFile(file, "process.exit(0);\n", "utf8");
	return file;
}

async function dyingHelper(script: string): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "cu-linux-helper-"));
	const file = path.join(dir, "linux-bridge");
	await writeFile(file, `#!/bin/sh\n${script}\n`, "utf8");
	await chmod(file, 0o755);
	return file;
}

// A helper whose stdin dies under an in-flight command leaves the socket to emit EPIPE.
// Without a listener Node raises that as an unhandled 'error' event, which ends the whole
// Pi process instead of the one command. Observed on a sandbox Linux host where the bridge
// could not run (FrontierHarness `mteb-leaderboard`). The test forces the same stream state
// by destroying the child's stdin, because racing a real helper exit is not deterministic.
test("a dying helper stdin rejects the in-flight command instead of killing the process", async () => {
	const helper = new LinuxHelperClient({
		helperPath: await dyingHelper("sleep 5"),
		// The product setup script refuses to install a Linux bridge on a non-Linux host.
		setupHelperScript: await noopSetup(),
	});
	const inFlight = helper.command("diagnostics", {}, { timeoutMs: 5_000 });
	const client = helper as unknown as { child?: { stdin: { destroy(error?: Error): void } } };
	for (let attempt = 0; attempt < 1_000 && !client.child; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(client.child, "the helper process was spawned");
	client.child.stdin.destroy(new Error("write EPIPE"));
	await assert.rejects(inFlight, isError);
	helper.dispose();
});

test("a dead helper stream also terminates the child so no orphan is left", async () => {
	const helper = new LinuxHelperClient({
		helperPath: await dyingHelper("sleep 5"),
		setupHelperScript: await noopSetup(),
	});
	const inFlight = helper.command("diagnostics", {}, { timeoutMs: 5_000 });
	const client = helper as unknown as {
		child?: { stdin: { destroy(error?: Error): void }; exitCode: number | null; signalCode: NodeJS.Signals | null };
	};
	for (let attempt = 0; attempt < 1_000 && !client.child; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
	const child = client.child;
	assert.ok(child, "the helper process was spawned");
	child.stdin.destroy(new Error("write EPIPE"));
	await assert.rejects(inFlight, isError);
	// Without the kill the `sleep 5` helper outlives the failed command.
	for (let attempt = 0; attempt < 500 && child.exitCode === null && child.signalCode === null; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(child.exitCode !== null || child.signalCode !== null, "the child was terminated after the stream error");
	helper.dispose();
});

test("a helper that exits before reading stdin rejects instead of crashing", async () => {
	const helper = new LinuxHelperClient({ helperPath: await dyingHelper("exit 1"), setupHelperScript: await noopSetup() });
	await assert.rejects(helper.command("diagnostics", {}, { timeoutMs: 5_000 }), isError);
	helper.dispose();
});

test("a missing helper executable rejects instead of crashing", async () => {
	const helper = new LinuxHelperClient({
		helperPath: path.join(os.tmpdir(), "cu-linux-helper-missing-binary"),
		setupHelperScript: await noopSetup(),
	});
	await assert.rejects(helper.command("diagnostics", {}, { timeoutMs: 5_000 }), isError);
	helper.dispose();
});
