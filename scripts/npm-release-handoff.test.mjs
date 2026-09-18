import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffCommands, inspectArtifact, preflightRelease, verifyRelease } from "./npm-release-handoff.mjs";

function fixture(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-release-handoff-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packageDir = join(root, "package");
	mkdirSync(packageDir);
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({
		name: "@bingjiang0611/rotom",
		version: "9.8.7",
		private: false,
		publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
	}));
	writeFileSync(join(packageDir, "payload.txt"), "frozen-release\n");
	const artifact = join(root, "rotom-9.8.7.tgz");
	execFileSync("tar", ["-czf", artifact, "-C", root, "package"]);
	return { root, artifact, bytes: readFileSync(artifact) };
}

function response(value, status = 200) {
	return new Response(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value), {
		status,
		headers: { "content-type": Buffer.isBuffer(value) ? "application/octet-stream" : "application/json" },
	});
}

test("artifact inspection is canonical, bounded and identity preserving", (t) => {
	const { root, artifact } = fixture(t);
	const info = inspectArtifact(artifact);
	assert.equal(info.version, "9.8.7");
	assert.equal(info.name, "@bingjiang0611/rotom");
	assert.match(info.sha256, /^[a-f0-9]{64}$/u);
	assert.match(info.integrity, /^sha512-/u);
	const link = join(root, "linked.tgz");
	symlinkSync(artifact, link);
	assert.throws(() => inspectArtifact(link), /canonical regular file/);
	assert.throws(() => inspectArtifact("relative.tgz"), /absolute/);
});

test("handoff prints phased maintainer commands without executing auth, publish or installation", (t) => {
	const { artifact } = fixture(t);
	const output = handoffCommands(artifact, "latest");
	for (const phrase of ["npm login --auth-type=web", "npm whoami", "ROTOM_NPM_AUTH_DIR", "NPM_CONFIG_USERCONFIG", "unset NPM_TOKEN NODE_AUTH_TOKEN", " preflight ", "npm publish", " verify ", "install-release.sh", "rotom --version --verbose", "npm logout"]) assert.match(output, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(output, /不要盲目重发 publish/u);
	assert.doesNotMatch(output, /osascript|open https|--otp/u);
});

test("preflight proves absence and rejects an existing immutable version", async (t) => {
	const { artifact } = fixture(t);
	const absent = async (url) => url.endsWith("/9.8.7") ? response({}, 404) : response({ name: "@bingjiang0611/rotom", "dist-tags": { latest: "9.8.6" } });
	assert.deepEqual(await preflightRelease(artifact, "latest", absent), {
		...inspectArtifact(artifact), tag: "latest", currentTag: "9.8.6", targetAbsent: true,
	});
	await assert.rejects(preflightRelease(artifact, "latest", async () => response({ version: "9.8.7" })), /already exists/);
});

test("post-publish verification requires exact tag, digests and tarball bytes", async (t) => {
	const { artifact, bytes } = fixture(t);
	const local = inspectArtifact(artifact);
	const tarball = "https://registry.npmjs.org/@bingjiang0611/rotom/-/rotom-9.8.7.tgz";
	const fetchExact = async (url) => {
		url = String(url);
		if (url.endsWith("/9.8.7")) return response({ name: local.name, version: local.version, dist: { integrity: local.integrity, shasum: local.shasum, tarball } });
		if (url === "https://registry.npmjs.org/%40bingjiang0611%2Frotom") return response({ name: local.name, "dist-tags": { latest: local.version } });
		if (url === tarball) return response(bytes);
		throw new Error(`unexpected URL ${url}`);
	};
	const verified = await verifyRelease(artifact, "latest", fetchExact);
	assert.equal(verified.verified, true);
	assert.equal(verified.tarball, tarball);
	await assert.rejects(verifyRelease(artifact, "latest", async (url) => {
		const exact = await fetchExact(url);
		if (String(url) === tarball) return response(Buffer.from("different"));
		return exact;
	}), /tarball bytes differ/);
});

test("CLI commands mode performs no network and emits artifact evidence", (t) => {
	const { artifact } = fixture(t);
	const result = spawnSync(process.execPath, [join(import.meta.dirname, "npm-release-handoff.mjs"), "commands", artifact, "latest"], {
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: t.mock ? undefined : process.env.HOME },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"version": "9\.8\.7"/u);
	assert.match(result.stdout, /npm publish/u);
	const syntax = spawnSync("sh", ["-n"], { encoding: "utf8", input: result.stdout });
	assert.equal(syntax.status, 0, syntax.stderr);
});
