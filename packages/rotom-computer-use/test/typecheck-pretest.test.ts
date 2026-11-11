import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Exercise the actual npm hook, including an error the transitional fatal gate allowed.
test("pretest rejects ordinary type errors and accepts a clean project", () => {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	assert.equal(scripts.pretest, "npm run typecheck");
	const dir = mkdtempSync(path.join(tmpdir(), "cu-full-typecheck-"));
	try {
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({
			private: true,
			scripts: { pretest: scripts.pretest, typecheck: scripts.typecheck },
		}));
		writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
			compilerOptions: { strict: true, noEmit: true, types: [] },
			files: ["fixture.ts"],
		}));
		const run = () => spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "pretest"], {
			cwd: dir,
			shell: process.platform === "win32",
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}` },
		});
		writeFileSync(path.join(dir, "fixture.ts"), 'const value: number = "not a number";\n');
		const rejected = run();
		assert.equal(rejected.error, undefined);
		assert.equal(rejected.signal, null);
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.stdout + rejected.stderr, /error TS2322:/);
		writeFileSync(path.join(dir, "fixture.ts"), "const value: number = 42;\n");
		const accepted = run();
		assert.equal(accepted.error, undefined);
		assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
