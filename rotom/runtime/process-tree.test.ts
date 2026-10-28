import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeProcessTreeV1 } from "./process-tree.ts";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function stableSize(filePath: string): Promise<void> {
	const before = (await stat(filePath)).size;
	await pause(200);
	assert.equal((await stat(filePath)).size, before, "runner 返回后 descendant 仍在写 sentinel");
}

test("正常退出也会清理后台 descendant，并确认整个 process group 消失", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-process-tree-success-"));
	const sentinel = join(directory, "sentinel");
	try {
		const result = await executeProcessTreeV1("/bin/sh", ["-lc", `(while :; do printf x >> '${sentinel}'; sleep 0.02; done) >/dev/null 2>&1 & until [ -s '${sentinel}' ]; do sleep 0.005; done; exit 0`], { timeoutMs: 5_000 });
		assert.equal(result.terminal.outcome, "exited");
		assert.equal(result.terminal.confirmed, true);
		await stableSize(sentinel);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("timeout 与 Abort 会升级 SIGKILL，返回前停止 sentinel", async (t) => {
	for (const mode of ["timeout", "aborted"] as const) await t.test(mode, async () => {
		const directory = await mkdtemp(join(tmpdir(), `pi-process-tree-${mode}-`));
		const sentinel = join(directory, "sentinel");
		const controller = new AbortController();
		const abortTimer = mode === "aborted" ? setTimeout(() => controller.abort(), 500) : undefined;
		try {
			const result = await executeProcessTreeV1("/bin/sh", ["-lc", `trap '' TERM; while :; do printf x >> '${sentinel}'; sleep 0.02; done`], {
				timeoutMs: mode === "timeout" ? 500 : 5_000,
				signal: controller.signal,
			});
			assert.equal(result.terminal.outcome, mode);
			assert.equal(result.terminal.confirmed, true);
			await stableSize(sentinel);
		} finally {
			if (abortTimer) clearTimeout(abortTimer);
			await rm(directory, { recursive: true, force: true });
		}
	});
});

test("combined output 超限时终止整个 process group，且捕获量严格有界", async () => {
	const result = await executeProcessTreeV1("/bin/sh", ["-lc", "trap '' TERM; while :; do printf 1234567890; done"], { timeoutMs: 5_000, maxOutputBytes: 1024 });
	assert.equal(result.terminal.outcome, "output-limit");
	assert.equal(result.terminal.confirmed, true);
	assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1024);
});
