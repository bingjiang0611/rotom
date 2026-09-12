// Maintenance-only bounded counterfactuals. No full upstream suite or model calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.SUBAGENT_UPSTREAM_SOURCE;
const tag = "afa22c811f81883acdb248c84f116ac7534e2fb4";
const migration = path.join(here, "subagent-upstream-contract-tests.patch");
const sourcePatches = ["wait", "owner-loss", "lifeline", "startup"].map(
	(name) => path.join(here, `subagent-${name}-candidate.patch`),
);
const tests = ["wait-subscriptions", "subagent-control", "spawn-budget"].map(
	(name) => `test/unit/${name}.test.ts`,
);
function run(command, args, cwd, env, input) {
	return spawnSync(command, args, {
		cwd,
		env,
		input,
		timeout: 30000,
		killSignal: "SIGKILL",
		maxBuffer: 16 * 1024 * 1024,
	});
}
function checked(result) {
	assert.ifError(result.error);
	assert.equal(
		result.status,
		0,
		"fixture preparation/typecheck failed; inspect the retained local fixture",
	);
	return result.stdout;
}
test("upstream contract migration changes tests only and keeps source candidates separate", () => {
	const text = fs.readFileSync(migration, "utf8");
	const paths = [...text.matchAll(/^\+\+\+ b\/(.*)$/gm)].map((m) => m[1]);
	assert.deepEqual(paths, [
		"test/unit/subagent-control.test.ts",
		"test/unit/wait-subscriptions.test.ts",
	]);
	assert.deepEqual(
		[...text.matchAll(/^--- a\/(.*)$/gm)].map((m) => m[1]),
		paths,
	);
	assert.doesNotMatch(
		text,
		/^diff --git/m,
		"only the two unified test-file diffs are allowed",
	);
	for (const file of sourcePatches) assert.ok(fs.lstatSync(file).isFile());
});
test(
	"original and migrated upstream contracts distinguish baseline from candidate",
	{ skip: !source },
	async (t) => {
		assert.ok(
			Number(process.versions.node.split(".")[0]) >= 24,
			"Node 24 is required for in-process test isolation",
		);
		const upstream = fs.realpathSync(source);
		assert.equal(
			fs.realpathSync(path.join(upstream, "node_modules")),
			path.resolve(upstream, "node_modules"),
			"use the isolated upstream dependency tree, not an installed-source alias",
		);
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "dev-agent-upstream-contract-"),
		);
		let retain = true;
		const env = {
			PATH: process.env.PATH,
			HOME: path.join(root, "home"),
			TMPDIR: root,
			LANG: "C",
			NO_COLOR: "1",
		};
		fs.mkdirSync(env.HOME);
		try {
			assert.equal(
				checked(run("git", ["rev-parse", "--show-toplevel"], upstream, env))
					.toString()
					.trim(),
				upstream,
			);
			assert.equal(
				checked(run("git", ["rev-parse", "HEAD"], upstream, env))
					.toString()
					.trim(),
				tag,
			);
			const template = path.join(root, "template");
			fs.mkdirSync(template);
			checked(
				run(
					"tar",
					["-x", "-C", template],
					root,
					env,
					checked(run("git", ["archive", tag], upstream, env)),
				),
			);
			const pkg = JSON.parse(
				fs.readFileSync(path.join(template, "package.json"), "utf8"),
			);
			assert.equal(pkg.name, "pi-subagents");
			assert.equal(pkg.version, "0.52.1");
			assert.equal(pkg.scripts.typecheck, "tsc --noEmit");
			for (const f of [...tests, "test/support/isolated-temp-root.mjs"])
				assert.ok(fs.lstatSync(path.join(template, f)).isFile());
			assert.ok(
				fs
					.statSync(path.join(upstream, "node_modules/typescript/bin/tsc"))
					.isFile(),
			);
			const variants = [
				{
					name: "baseline-original",
					candidate: false,
					migrated: false,
					pass: 42,
					fail: 0,
				},
				{
					name: "candidate-original",
					candidate: true,
					migrated: false,
					pass: 34,
					fail: 8,
				},
				{
					name: "candidate-migrated",
					candidate: true,
					migrated: true,
					pass: 45,
					fail: 0,
				},
				{
					name: "baseline-migrated",
					candidate: false,
					migrated: true,
					pass: 40,
					fail: 5,
				},
			];
			for (const variant of variants) {
				const cwd = path.join(root, variant.name);
				fs.cpSync(template, cwd, { recursive: true });
				// Read-only dependency reuse, with a package-local link so nested fixtures
				// resolve dependencies too. Never patch or install anything in node_modules.
				fs.symlinkSync(
					path.join(upstream, "node_modules"),
					path.join(cwd, "node_modules"),
					"dir",
				);
				for (const patch of [
					...(variant.candidate ? sourcePatches : []),
					...(variant.migrated ? [migration] : []),
				])
					checked(run("git", ["apply", "--unidiff-zero", patch], cwd, env));
				const result = run(
					process.execPath,
					[
						"--experimental-strip-types",
						"--import",
						"./test/support/isolated-temp-root.mjs",
						"--test",
						"--experimental-test-isolation=none",
						"--test-concurrency=1",
						"--test-reporter=tap",
						...tests,
					],
					cwd,
					env,
				);
				const output = Buffer.concat([
					result.stdout ?? Buffer.alloc(0),
					result.stderr ?? Buffer.alloc(0),
				]);
				fs.writeFileSync(path.join(root, variant.name + ".log"), output, {
					mode: 0o600,
				});
				assert.ifError(result.error);
				assert.equal(
					result.signal,
					null,
					"termination is not a completed gate",
				);
				const text = output.toString("utf8");
				const counts = {};
				for (const key of ["tests", "pass", "fail", "cancelled", "skipped"]) {
					const m = text.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
					assert.ok(m, `missing ${key} summary`);
					counts[key] = Number(m[1]);
				}
				assert.equal(counts.tests, variant.pass + variant.fail);
				assert.equal(counts.pass, variant.pass);
				assert.equal(counts.fail, variant.fail);
				assert.equal(counts.cancelled, 0);
				assert.equal(counts.skipped, 0);
				assert.equal(result.status, variant.fail ? 1 : 0);
				let failedTitle;
				const failures = [];
				for (const line of text.split("\n")) {
					const failed = line.match(/^\s*not ok \d+ - (.*)$/);
					if (failed) failedTitle = failed[1];
					if (/failureType: 'testCodeFailure'/.test(line))
						failures.push(failedTitle);
				}
				const expectedFailures =
					variant.name === "candidate-original"
						? [
								"builds compact needs-attention control events",
								"restores durable registrations and wakes on exact completion",
								"keeps subscriptions active across a session restart",
								"waits for foreground run restoration before reconciling a restored subscription",
								"keeps a subscription armed when cleanup fails before delivery",
								"wakes when an exact async run cannot be reconciled",
								"wakes for attention and timeout without treating subscriptions as child work",
								"still gives the owning session its timeout notice after a restart",
							]
						: variant.name === "baseline-migrated"
							? [
									"builds compact needs-attention control events",
									"preserves event identity on serialization but distinguishes newly built identical events",
									"wakes for attention and timeout without treating subscriptions as child work",
									"preserves accepted delivery across restart until an exact receipt in the file-first owner session",
									"never resends after a throwing dispatch; only a visible receipt can settle the unknown attempt",
								]
							: [];
				assert.deepEqual(
					failures.sort(),
					expectedFailures.sort(),
					"expected failure counts must not hide unrelated failures",
				);
				t.diagnostic(JSON.stringify({ variant: variant.name, ...counts }));
				if (variant.name === "candidate-migrated") {
					const checkedTypes = run(
						process.execPath,
						[
							path.join(upstream, "node_modules/typescript/bin/tsc"),
							"--noEmit",
						],
						cwd,
						env,
					);
					fs.writeFileSync(
						path.join(root, "typecheck.log"),
						Buffer.concat([
							checkedTypes.stdout ?? Buffer.alloc(0),
							checkedTypes.stderr ?? Buffer.alloc(0),
						]),
						{ mode: 0o600 },
					);
					checked(checkedTypes);
				}
			}
			retain = false;
		} finally {
			if (retain) t.diagnostic("Retained inconclusive fixture: " + root);
			else await fs.promises.rm(root, { recursive: true, force: true });
		}
	},
);
