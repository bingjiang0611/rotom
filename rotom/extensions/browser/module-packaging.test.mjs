import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { stageRelease } from "../../scripts/pack-release.mjs";

test("staged Browser package contains its complete local module graph", async (t) => {
	const workspace = mkdtempSync(join(tmpdir(), "rotom-browser-modules-"));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const staged = join(workspace, "package");
	await stageRelease(resolve(import.meta.dirname, "../.."), staged);
	const root = join(staged, "extensions/browser");
	function checkImports() {
		const pending = [join(root, "index.ts")];
		const visited = new Set();
		while (pending.length > 0) {
			const path = pending.pop();
			if (visited.has(path)) continue;
			visited.add(path);
			const source = readFileSync(path, "utf8");
			for (const match of source.matchAll(/^(?:import|export)\s+[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
				const target = resolve(dirname(path), match[1]);
				assert.ok(existsSync(target), `Missing staged Browser import: ${target}`);
				if (dirname(target) === root) pending.push(target);
			}
		}
		return visited;
	}
	assert.ok(checkImports().has(join(root, "inspect-execute.ts")));
	rmSync(join(root, "inspect-execute.ts"));
	assert.throws(checkImports, /Missing staged Browser import: .*inspect-execute\.ts/);
});
