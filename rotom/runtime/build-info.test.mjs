import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildInfoFor, verifyReleaseClosure } from "../scripts/pack-release.mjs";
import { BUILD_INFO_SCHEMA, parseBuildInfo, readBuildIdentity } from "./build-info.mjs";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const TIME = "2026-11-11T00:00:00.000Z";
const stamp = (extra = {}) => JSON.stringify({ schema: BUILD_INFO_SCHEMA, commit: COMMIT, dirty: false, allowDirty: false, builtAt: TIME, ...extra });

function temporary(run) {
	const root = mkdtempSync(join(tmpdir(), "rotom-build-identity-"));
	return Promise.resolve().then(() => run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("stamp validation and dirty-build opt-in", () => {
	assert.equal(buildInfoFor(COMMIT, false, TIME).commit, COMMIT);
	assert.throws(() => buildInfoFor(COMMIT, true, TIME), /Refusing to pack a dirty tree/);
	assert.deepEqual(buildInfoFor(COMMIT, true, TIME, true), JSON.parse(stamp({ dirty: true, allowDirty: true })));
	for (const patch of [{ commit: "abc" }, { dirty: "no" }, { dirty: true }, { allowDirty: true }, { builtAt: "2026-02-30T00:00:00.000Z" }, { schema: "other" }]) {
		assert.throws(() => parseBuildInfo(stamp(patch)));
	}
});

test("closure check requires a valid build stamp before checking imports", () => temporary(async (root) => {
	writeFileSync(join(root, "entry.mjs"), "import './dependency.mjs';\n");
	const files = ["build-info.json", "entry.mjs", "dependency.mjs"];
	await assert.rejects(verifyReleaseClosure(root, files), /build-info.json/);
	writeFileSync(join(root, "build-info.json"), stamp({ commit: "abc" }));
	await assert.rejects(verifyReleaseClosure(root, files), /full 40-character SHA/);
	writeFileSync(join(root, "build-info.json"), stamp());
	await assert.rejects(verifyReleaseClosure(root, files), /dependency.mjs/);
	writeFileSync(join(root, "dependency.mjs"), "export default true;\n");
	await verifyReleaseClosure(root, files);
}));

test("checkout identity: clean, tracked change, staged change, untracked file, missing stamp", () => temporary((root) => {
	const product = join(root, "rotom");
	mkdirSync(product);
	const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@users.noreply.github.com");
	writeFileSync(join(product, "source.mjs"), "export default 1;\n");
	git("add", ".");
	git("commit", "-qm", "fixture");
	const commit = git("rev-parse", "HEAD");
	assert.deepEqual(readBuildIdentity(product), { commit, dirty: false });
	writeFileSync(join(product, "source.mjs"), "export default 2;\n");
	assert.deepEqual(readBuildIdentity(product), { commit, dirty: true });
	git("add", ".");
	assert.equal(readBuildIdentity(product).dirty, true);
	git("reset", "--hard", "HEAD");
	writeFileSync(join(product, "untracked"), "x");
	assert.equal(readBuildIdentity(product).dirty, true);
	writeFileSync(join(product, "build-info.json"), stamp());
	assert.equal(readBuildIdentity(product).commit, commit, "checkout Git identity wins over a stale copied stamp");
	const consumer = join(root, "node_modules", "rotom");
	mkdirSync(consumer, { recursive: true });
	assert.equal(readBuildIdentity(consumer), undefined, "never borrow the consumer repository's commit");
}));

test("unstamped installation stays unknown; malformed and symlink stamps cannot fall back to Git", () => temporary((root) => {
	assert.equal(readBuildIdentity(root), undefined);
	writeFileSync(join(root, "build-info.json"), stamp({ dirty: true, allowDirty: true }));
	assert.equal(readBuildIdentity(root).dirty, true);
	writeFileSync(join(root, "build-info.json"), "{");
	assert.throws(() => readBuildIdentity(root), /not JSON/);
	rmSync(join(root, "build-info.json"));
	writeFileSync(join(root, "outside.json"), stamp());
	symlinkSync("outside.json", join(root, "build-info.json"));
	assert.throws(() => readBuildIdentity(root), /not a regular file/);
}));

test("real launcher version probe overwrites inherited build metadata without calling a model", () => temporary((root) => {
	const product = resolve(import.meta.dirname, "..");
	const capture = join(root, "capture.json");
	const preload = join(root, "capture.mjs");
	writeFileSync(preload, 'import { writeFileSync } from "node:fs"; process.on("exit", () => writeFileSync(process.env.CAPTURE, JSON.stringify({commit:process.env.ROTOM_BUILD_COMMIT,dirty:process.env.ROTOM_BUILD_DIRTY})));\n');
	const result = execFileSync(join(product, "bin/rotom"), ["--version"], {
		encoding: "utf8",
		env: { ...process.env, HOME: root, ROTOM_NODE: process.execPath, ROTOM_BUILD_COMMIT: "f".repeat(40), ROTOM_BUILD_DIRTY: "1", CAPTURE: capture, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
	});
	assert.equal(result.trim(), JSON.parse(readFileSync(join(product, "package.json"), "utf8")).version);
	const identity = readBuildIdentity(product);
	assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { commit: identity.commit, dirty: identity.dirty ? "1" : "0" });
}));
