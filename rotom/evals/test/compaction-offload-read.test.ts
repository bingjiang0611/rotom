import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { REPLAY_PRODUCT, REPLAY_TASKS, writeReplayFixture } from "../src/compaction-offload-cases.ts";

const { createReadTool } = await import(pathToFileURL(resolve(REPLAY_PRODUCT, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js")).href);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("the actual product read tool reads every fixture whole, rejects directories/globs and truncates oversized text", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "offload-read-")); roots.push(workspace);
	const read = (args: { path: string; offset?: number; limit?: number }) => createReadTool(workspace).execute("read-check", args);
	for (const task of REPLAY_TASKS) {
		await writeReplayFixture(workspace, task);
		for (const path of ["manifest.json", ...task.reading]) {
			const result = await read({ path });
			expect(result.content).toEqual([{ type: "text", text: task.files[path] }]);
			expect(result.details).toBeUndefined();
		}
	}
	await expect(read({ path: "modules" })).rejects.toThrow(/EISDIR/u);
	await expect(read({ path: "modules/*.mjs" })).rejects.toThrow(/ENOENT/u);
	await writeFile(join(workspace, "many-lines.txt"), "short line\n".repeat(2500));
	await writeFile(join(workspace, "many-bytes.txt"), ("x".repeat(100) + "\n").repeat(1000));
	await writeFile(join(workspace, "one-huge-line.txt"), "x".repeat(60 * 1024));
	expect((await read({ path: "many-lines.txt" })).details.truncation).toMatchObject({ truncated: true, truncatedBy: "lines", outputLines: 2000 });
	expect((await read({ path: "many-bytes.txt" })).details.truncation).toMatchObject({ truncated: true, truncatedBy: "bytes" });
	expect((await read({ path: "one-huge-line.txt" })).details.truncation.firstLineExceedsLimit).toBe(true);
	const partial = await read({ path: "many-lines.txt", offset: 2, limit: 1 });
	expect(partial.content[0].text).toContain("Use offset=3");
});
