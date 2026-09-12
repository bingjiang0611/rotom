import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DISTRIBUTION_PI_VERSION, RESOURCE_DESCRIPTORS_V1, VERIFIED_PI_PACKAGE, VERIFIED_THIRD_PARTY_PACKAGES } from "./product-config.mjs";
import { PI_MODULES, PI_RUNTIME, resolveInstalledPi, verifyDistributionContract } from "./resolve-installed-pi.mjs";
import { EMBEDDED_MODULES, releaseFiles, stageRelease, verifyPackList } from "../scripts/pack-release.mjs";

const SOURCE = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8"));
function temp(t) {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "rotom-distribution-test-")));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}
function put(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
function fixture(t) {
	const work = temp(t);
	const root = join(work, "node_modules/rotom");
	put(join(root, "package.json"), manifest);
	cpSync(join(SOURCE, "npm-shrinkwrap.json"), join(root, "npm-shrinkwrap.json"));
	const build = JSON.parse(readFileSync(join(SOURCE, PI_RUNTIME, "fork-build.json"), "utf8"));
	for (const file of ["package.json", "package-lock.json", "fork-build.json", ...Object.values(build.artifacts).map((a) => a.file)]) {
		const target = join(root, PI_RUNTIME, file);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(SOURCE, PI_RUNTIME, file), target);
	}
	const rotomFork = { sourceSha256: build.sourceSha256, revision: build.upstreamRevision };
	for (const name of Object.keys(build.artifacts)) put(join(root, PI_MODULES, name, "package.json"), { name, version: build.version, rotomFork });
	const pi = join(root, PI_MODULES, VERIFIED_PI_PACKAGE);
	const pkg = { name: VERIFIED_PI_PACKAGE, version: DISTRIBUTION_PI_VERSION, rotomFork, type: "module", bin: { pi: "cli.js" }, exports: { ".": { import: "./index.js" } } };
	put(join(pi, "package.json"), pkg);
	put(join(pi, "cli.js"), "#!/bin/sh\nexit 99\n");
	chmodSync(join(pi, "cli.js"), 0o755);
	put(join(pi, "index.js"), "throw new Error('resolver must not import SDK');\n");
	return { work, root, pi, pkg };
}

test("distribution is public-scoped, owns its Pi fork, has no installation hooks and declares the public bin", async () => {
	assert.equal(manifest.name, "@bingjiang0611/rotom");
	assert.equal(manifest.private, false);
	assert.deepEqual(manifest.publishConfig, { access: "public", registry: "https://registry.npmjs.org" });
	assert.equal(manifest.license, "UNLICENSED");
	assert.equal(manifest.dependencies, undefined);
	assert.ok(manifest.files.includes(PI_MODULES));
	assert.deepEqual(manifest.bin, { rotom: "bin/rotom" });
	for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(manifest.scripts[hook], undefined);
	await verifyDistributionContract(SOURCE);
});

test("resolves product-owned Pi using bin.pi without importing SDK", async (t) => {
	const { root, pi } = fixture(t);
	assert.equal(await resolveInstalledPi(root), join(pi, "cli.js"));
});

test("does not use an ancestor/official Pi when its bundled fork is missing", async (t) => {
	const { root, pi, work } = fixture(t);
	cpSync(pi, join(work, "node_modules", VERIFIED_PI_PACKAGE), { recursive: true });
	rmSync(pi, { recursive: true });
	await assert.rejects(resolveInstalledPi(root), /缺少/);
});

for (const change of ["version", "name", "bin-escape", "bin-symlink", "parent-symlink", "metadata-symlink", "public-escape", "public-symlink"]) {
	test(`rejects installed Pi ${change}`, async (t) => {
		const { work, root, pi, pkg } = fixture(t);
		if (change === "version") pkg.version = "0.85.2";
		if (change === "name") pkg.name = "fake-pi";
		if (change === "bin-escape") pkg.bin.pi = "../escape.js";
		if (change === "public-escape") { pkg.exports["."].import = "../escape.js"; put(join(pi, "../escape.js"), ""); }
		put(join(pi, "package.json"), pkg);
		if (change === "bin-symlink") { rmSync(join(pi, "cli.js")); symlinkSync("index.js", join(pi, "cli.js")); }
		if (change === "public-symlink") { put(join(pi, "entry.js"), ""); rmSync(join(pi, "index.js")); symlinkSync("entry.js", join(pi, "index.js")); }
		if (change === "metadata-symlink") { put(join(work, "package.json"), pkg); rmSync(join(pi, "package.json")); symlinkSync(join(work, "package.json"), join(pi, "package.json")); }
		if (change === "parent-symlink") { cpSync(pi, join(work, "external"), { recursive: true }); rmSync(pi, { recursive: true }); symlinkSync(join(work, "external"), pi); }
		await assert.rejects(resolveInstalledPi(root));
	});
}

test("missing installed dependency fails closed despite PATH and NODE_PATH", async (t) => {
	const { root, pi, work } = fixture(t);
	rmSync(pi, { recursive: true });
	const bin = join(work, "bin");
	put(join(bin, "pi"), `#!/bin/sh\ntouch '${join(work, "executed")}'\n`);
	chmodSync(join(bin, "pi"), 0o755);
	const result = spawnSync(process.execPath, [join(SOURCE, "runtime/resolve-installed-pi.mjs"), root], { env: { PATH: bin, NODE_PATH: bin }, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /缺少 rotom 随附的 Pi fork/);
	assert.equal(existsSync(join(work, "executed")), false);
});

test("rejects manifest and shrinkwrap drift, not just installed version", async (t) => {
	const { root } = fixture(t);
	const lockPath = join(root, PI_RUNTIME, "package-lock.json");
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	const integrity = lock.packages[`node_modules/${VERIFIED_PI_PACKAGE}`].integrity;
	assert.match(integrity, /^sha512-/);
	lock.packages[`node_modules/${VERIFIED_PI_PACKAGE}`].integrity = "sha512-wrong";
	put(lockPath, lock);
	await assert.rejects(resolveInstalledPi(root), /shrinkwrap integrity/);
	cpSync(join(SOURCE, PI_RUNTIME, "package-lock.json"), lockPath);
	put(join(root, "package.json"), { ...manifest, dependencies: { [VERIFIED_PI_PACKAGE]: "^0.85.1" } });
	await assert.rejects(resolveInstalledPi(root), /dependency/);
	put(join(root, "package.json"), manifest);
	const original = JSON.parse(readFileSync(join(SOURCE, PI_RUNTIME, "package-lock.json"), "utf8"));
	const transitive = "node_modules/chalk";
	delete original.packages[transitive].integrity;
	put(lockPath, original);
	await assert.rejects(resolveInstalledPi(root), /transitive source\/integrity/);
	original.packages[transitive].integrity = integrity;
	original.packages[transitive].resolved = "https://example.invalid/untrusted.tgz";
	put(lockPath, original);
	await assert.rejects(resolveInstalledPi(root), /transitive source\/integrity/);
});

for (const drift of ["archive", "build-metadata", "installed-source", "sibling-package", "hidden-official", "local-url"]) {
	test(`rejects fork ${drift} drift`, async (t) => {
		const { root, pi, pkg } = fixture(t);
		const build = JSON.parse(readFileSync(join(root, PI_RUNTIME, "fork-build.json"), "utf8"));
		if (drift === "archive") put(join(root, PI_RUNTIME, build.artifacts[VERIFIED_PI_PACKAGE].file), "bad archive");
		if (drift === "build-metadata") put(join(root, PI_RUNTIME, "fork-build.json"), { ...build, sourceSha256: "wrong" });
		if (drift === "installed-source") { pkg.rotomFork.sourceSha256 = "wrong"; put(join(pi, "package.json"), pkg); }
		if (drift === "sibling-package") put(join(root, PI_MODULES, "@earendil-works/pi-ai/package.json"), { name: "@earendil-works/pi-ai", version: "0.85.1" });
		if (drift === "hidden-official" || drift === "local-url") {
			const path = join(root, PI_RUNTIME, "package-lock.json");
			const lock = JSON.parse(readFileSync(path, "utf8"));
			if (drift === "hidden-official") lock.packages["node_modules/example/node_modules/@earendil-works/pi-ai"] = { ...lock.packages["node_modules/chalk"] };
			else lock.packages["node_modules/chalk"].resolved = "file:vendor/unreviewed.tgz";
			put(path, lock);
		}
		await assert.rejects(resolveInstalledPi(root));
	});
}

test("npm bin symlink chains preserve business cwd, argv, environment and exit status", (t) => {
	const root = temp(t);
	const bin = join(root, "lib/node_modules/rotom/bin");
	mkdirSync(bin, { recursive: true });
	cpSync(join(SOURCE, "bin/rotom"), join(bin, "rotom"));
	const capture = join(root, "capture.json");
	const script = "require('node:fs').writeFileSync(process.env.CAPTURE,JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(1),value:process.env.MARKER}));process.exit(37)";
	put(join(bin, "rotom-launcher"), `#!/bin/sh\nexec "$FIXTURE_NODE" -e "${script}" -- "$@"\n`);
	chmodSync(join(bin, "rotom-launcher"), 0o755);
	mkdirSync(join(root, "bin"));
	symlinkSync("../lib/node_modules/rotom/bin/rotom", join(root, "bin/rotom-real"));
	symlinkSync("rotom-real", join(root, "bin/rotom"));
	const cwd = join(root, "business space");
	mkdirSync(cwd);
	const argv = ["--model", "test/model", "Unicode 洛托姆", "line1\nline2", "$(not-a-command)", ""];
	const result = spawnSync(join(root, "bin/rotom"), argv, { cwd, env: { PATH: "/usr/bin:/bin", FIXTURE_NODE: process.execPath, CAPTURE: capture, MARKER: "kept" }, encoding: "utf8" });
	assert.equal(result.status, 37, result.stderr);
	assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { cwd, argv, value: "kept" });
});

test("release staging does not require or recreate a nested product README", async (t) => {
	assert.equal(existsSync(join(SOURCE, "README.md")), false);
	assert.ok(existsSync(join(SOURCE, "../README.md")));
	assert.ok(existsSync(join(SOURCE, "../docs/usage.md")));
	assert.equal(manifest.files.includes("README.md"), false);
	const stage = join(temp(t), "product");
	await stageRelease(SOURCE, stage);
	assert.equal(existsSync(join(stage, "README.md")), false);
	assert.ok(existsSync(join(stage, "bin/rotom")));
	assert.ok(existsSync(join(stage, "THIRD_PARTY_NOTICES.md")));
});

test("staging uses an explicit file list and never copies source node_modules or private state", async (t) => {
	const root = temp(t);
	const source = join(root, "source");
	put(join(source, "package.json"), { files: ["bin/rotom", EMBEDDED_MODULES] });
	put(join(source, "bin/rotom"), "example");
	put(join(source, EMBEDDED_MODULES, "private.txt"), "do not copy");
	put(join(source, ".pi/tasks/private.txt"), "do not copy");
	const stage = join(root, "stage");
	await stageRelease(source, stage);
	assert.equal(existsSync(join(stage, EMBEDDED_MODULES)), false);
	assert.equal(existsSync(join(stage, ".pi")), false);
	rmSync(join(source, "bin/rotom"));
	symlinkSync(join(source, EMBEDDED_MODULES, "private.txt"), join(source, "bin/rotom"));
	await assert.rejects(stageRelease(source, join(root, "bad")), /Untrusted release source/);
	for (const file of ["../secret", ".pi/tasks/a", "evals/data.json", "extensions/test.test.ts"]) {
		assert.throws(() => releaseFiles({ files: [file, EMBEDDED_MODULES] }));
	}
});

test("packed inventory requires every runtime resource and license and excludes unexpected source artifacts", () => {
	const paths = new Set(releaseFiles(manifest).filter((file) => file !== EMBEDDED_MODULES && file !== PI_MODULES));
	for (const name of ["chord", "pi-telemetry", "pi-ai", "pi-tui", "pi-agent-core", "pi-coding-agent"]) for (const file of ["LICENSE", "package.json"]) paths.add(`${PI_MODULES}/@earendil-works/${name}/${file}`);
	for (const r of RESOURCE_DESCRIPTORS_V1) for (const file of r.requiredFiles) paths.add(`${r.path}/${file}`);
	for (const name of Object.keys(VERIFIED_THIRD_PARTY_PACKAGES)) paths.add(`${EMBEDDED_MODULES}/${name}/LICENSE`);
	const packed = { files: [...paths].map((path) => ({ path })) };
	verifyPackList(manifest, packed);
	for (const path of [".pi/tasks/state.json", "extensions/third-party/subagent-results.json", "evals/trajectory.json"]) {
		assert.throws(() => verifyPackList(manifest, { files: [...packed.files, { path }] }));
	}
	assert.throws(() => verifyPackList(manifest, { files: packed.files.filter((f) => !f.path.endsWith("native-host.mjs")) }), /Missing packed/);
});
