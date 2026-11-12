import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { typecheckResult } from "../scripts/typecheck-fatal.mjs";

test("fatal gate keeps runtime errors, syntax/config failures and compiler failures blocking", () => {
	for (const code of [2304, 2552, 2307, 2305, 2614, 2724, 2792, 2882, 2348, 2349, 2351, 7009, 2448, 2454, 1005, 5023, 2688, 6053, 6054, 6231]) {
		assert.equal(typecheckResult({ status: 1, stdout: `fixture.ts(1,1): error TS${code}: fixture\n` }).exitCode, 1, String(code));
	}
	for (const result of [{ status: null, error: new Error("spawn failed") }, { status: null, signal: "SIGKILL" }, { status: 1, stderr: "unrecognized compiler failure" }, { status: 3, stdout: "error TS2322: fixture" }]) {
		assert.equal(typecheckResult(result).exitCode, 1);
	}
});

test("full diagnostics remain visible while typing-only debt does not stop the tests", () => {
	const stdout = "fixture.ts(1,1): error TS2322: fixture\nfixture.ts(2,1): error TS7006: fixture\n";
	assert.deepEqual(typecheckResult({ status: 1, stdout }), { output: stdout, diagnosticCount: 2, fatalCodes: [], exitCode: 0 });
	assert.equal(typecheckResult({ status: 0 }).exitCode, 0);
});

test("missing runtime properties block src/extensions but retain test-only type debt", () => {
	for (const code of [2339, 2551]) {
		for (const file of ["src/foo.ts", "extensions/foo.ts", "/tmp/project/src/foo.ts", "C:\\project\\src\\foo.ts"]) {
			assert.equal(typecheckResult({ status: 1, stdout: `${file}(1,1): error TS${code}: fixture` }).exitCode, 1, file);
		}
		assert.equal(typecheckResult({ status: 1, stdout: `test/foo.ts(1,1): error TS${code}: fixture` }).exitCode, 0);
	}
});

test("real compiler control: missing names/modules/exports/properties and non-callable values fail; typing mismatch passes", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cu-fatal-typecheck-"));
	try {
		writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, types: [] }, files: ["src/fixture.ts"] }));
		mkdirSync(path.join(dir, "src"));
		writeFileSync(path.join(dir, "src", "module.ts"), "export const present = 1;\n");
		for (const [source, status, code] of [
			["notDeclared();", 1, "TS2304"],
			['import { absent } from "./missing.js";', 1, "TS2307"],
			['import "./missing.js";', 1, "TS2882"],
			['import { absent } from "./module.js";', 1, "TS2305"],
			["const notCallable = 1; notCallable();", 1, "TS2349"],
			["new (1)();", 1, "TS2351"],
			["new (() => undefined)();", 1, "TS7009"],
			["({}).missing();", 1, "TS2339"],
			['"".toUppercase();', 1, "TS2551"],
			['const typed: number = "text";', 0, "TS2322"],
		] as const) {
			writeFileSync(path.join(dir, "src", "fixture.ts"), source);
			const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/typecheck-fatal.mjs", import.meta.url)), path.join(dir, "tsconfig.json")], { encoding: "utf8", timeout: 30_000 });
			assert.ifError(result.error);
			assert.equal(result.status, status, result.stdout + result.stderr);
			assert.ok(result.stdout.includes(code), result.stdout + result.stderr);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
