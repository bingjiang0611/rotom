import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	decideBrowserPolicyV1,
	grantBrowserPolicyV1,
	isLocalOriginV1,
	policyMatchesOriginV1,
	readBrowserPolicyV1,
	sanitizePolicyPatternV1,
	writeBrowserPolicyV1,
} from "./browser-policy.ts";

const workspace = await mkdtemp(join(tmpdir(), "rotom-browser-policy-"));
const policyPath = join(workspace, "rotom", "browser-policy.json");
const empty = { blocklist: [], allowlist: [] };

test("policy：显式 blocklist 优先，其他站点与 capability 默认完全访问", () => {
	// blocklist 先于 allowlist，也先于 localhost。
	const blocked = { blocklist: ["https://example.test"], allowlist: [{ origin: "https://example.test", capabilities: ["read"] }] };
	assert.deepEqual(decideBrowserPolicyV1(blocked, { origin: "https://example.test", capability: "read" }), { decision: "deny", reason: "blocklist", pattern: "https://example.test" });
	assert.deepEqual(decideBrowserPolicyV1({ blocklist: ["http://localhost:8080"], allowlist: [] }, { origin: "http://localhost:8080", capability: "read" }), { decision: "deny", reason: "blocklist", pattern: "http://localhost:8080" });
	// allowlist 命中就放行，但只放行列出的 capability。
	const allowed = { blocklist: [], allowlist: [{ origin: "https://example.test", capabilities: ["read"] }] };
	assert.deepEqual(decideBrowserPolicyV1(allowed, { origin: "https://example.test", capability: "read" }), { decision: "allow", reason: "allowlist", pattern: "https://example.test" });
	assert.deepEqual(decideBrowserPolicyV1(allowed, { origin: "https://example.test", capability: "interact" }), { decision: "allow", reason: "full-access" });
	// localhost 默认允许 read/interact，但 upload/devtools 仍要问。
	assert.deepEqual(decideBrowserPolicyV1(empty, { origin: "http://127.0.0.1:5123", capability: "interact" }), { decision: "allow", reason: "localhost", pattern: "http://127.0.0.1:5123" });
	assert.deepEqual(decideBrowserPolicyV1(empty, { origin: "http://localhost:3000", capability: "read" }), { decision: "allow", reason: "localhost", pattern: "http://localhost:3000" });
	for (const capability of ["read", "interact", "devtools", "upload", "download"]) {
		assert.deepEqual(decideBrowserPolicyV1(empty, { origin: "https://linear.app", capability }), { decision: "allow", reason: "full-access" });
	}
	assert.equal(decideBrowserPolicyV1(empty, { origin: "http://localhost:3000", capability: "upload" }).decision, "allow");
});

test("policy：通配符只匹配子域，host 与端口按 origin 处理", () => {
	assert.equal(policyMatchesOriginV1("*.example.test", "https://a.example.test"), true);
	assert.equal(policyMatchesOriginV1("*.example.test", "https://a.b.example.test"), true);
	assert.equal(policyMatchesOriginV1("*.example.test", "http://a.example.test"), true, "通配符不带 scheme，http/https 都算");
	assert.equal(policyMatchesOriginV1("*.example.test", "https://example.test"), false, "apex 必须单独授权");
	assert.equal(policyMatchesOriginV1("*.example.test", "https://notexample.test"), false);
	assert.equal(policyMatchesOriginV1("*.example.test", "https://a.example.test.evil.test"), false);
	assert.equal(policyMatchesOriginV1("https://example.test:8443", "https://example.test:8443"), true);
	assert.equal(policyMatchesOriginV1("https://example.test:8443", "https://example.test"), false, "端口不同就是不同 origin");
	assert.equal(sanitizePolicyPatternV1("*.Example.Test"), "*.example.test");
	assert.equal(sanitizePolicyPatternV1("*."), undefined);
	assert.equal(sanitizePolicyPatternV1("https://example.test/path"), "https://example.test");
	assert.equal(sanitizePolicyPatternV1("file:///tmp/x"), undefined);
	assert.equal(sanitizePolicyPatternV1(`${"a".repeat(300)}.test`), undefined);
	assert.equal(isLocalOriginV1("http://[::1]:8080"), true);
	assert.equal(isLocalOriginV1("https://example.test"), false);
});

test("policy：缺失文件等于空策略，非法内容与 symlink 是错误", async () => {
	assert.deepEqual(await readBrowserPolicyV1(join(workspace, "missing.json")), empty);
	await writeBrowserPolicyV1({ blocklist: ["https://blocked.test"], allowlist: [{ origin: "*.example.test", capabilities: ["read", "interact"] }] }, policyPath);
	const loaded = await readBrowserPolicyV1(policyPath);
	assert.deepEqual(loaded, { blocklist: ["https://blocked.test"], allowlist: [{ origin: "*.example.test", capabilities: ["read", "interact"] }] });
	const mode = (await import("node:fs/promises")).stat(policyPath).then((info) => info.mode & 0o777);
	assert.equal(await mode, 0o600, "策略文件必须是 0600");
	// 宽松权限、symlink、未知字段都必须报错，不能静默丢弃 blocklist。
	await chmod(policyPath, 0o644);
	await assert.rejects(readBrowserPolicyV1(policyPath), /权限/u);
	await chmod(policyPath, 0o600);
	const link = join(workspace, "link.json");
	await symlink(policyPath, link);
	await assert.rejects(readBrowserPolicyV1(link), /符号链接/u);
	const bad = join(workspace, "bad.json");
	await writeFile(bad, JSON.stringify({ schemaVersion: 1, blocklist: [], allowlist: [], extra: true }));
	await chmod(bad, 0o600);
	await assert.rejects(readBrowserPolicyV1(bad), /不接受字段/u);
	await writeFile(bad, JSON.stringify({ schemaVersion: 1, allowlist: [{ origin: "https://x.test", capabilities: ["superuser"] }] }));
	await assert.rejects(readBrowserPolicyV1(bad), /未知 capability/u);
	await writeFile(bad, "{not json");
	await assert.rejects(readBrowserPolicyV1(bad));
});

test("policy：总是允许会合并写回，重复授权不产生重复条目", async () => {
	const path = join(workspace, "grant", "browser-policy.json");
	await grantBrowserPolicyV1({ origin: "https://example.test", capability: "read", path });
	await grantBrowserPolicyV1({ origin: "https://example.test", capability: "interact", path });
	await grantBrowserPolicyV1({ origin: "https://example.test", capability: "read", path });
	const policy = await readBrowserPolicyV1(path);
	assert.deepEqual(policy.allowlist, [{ origin: "https://example.test", capabilities: ["read", "interact"] }]);
	// 写回的内容确实是合法 JSON 且带 schemaVersion。
	const raw = JSON.parse(await readFile(path, "utf8"));
	assert.equal(raw.schemaVersion, 1);
	await assert.rejects(grantBrowserPolicyV1({ origin: "file:///etc/passwd", capability: "read", path }), /非法 origin/u);
	await assert.rejects(writeBrowserPolicyV1({ blocklist: ["nonsense"], allowlist: [] }, path), /非法 origin/u);
	await rm(join(workspace, "grant"), { recursive: true, force: true });
});

test("policy：写回是原子替换，不跟随已存在的 symlink", async () => {
	const directory = join(workspace, "atomic");
	await writeBrowserPolicyV1(empty, join(directory, "browser-policy.json"));
	const target = join(workspace, "elsewhere.json");
	await writeFile(target, "{}");
	const path = join(directory, "browser-policy.json");
	await rm(path);
	await symlink(target, path);
	await assert.rejects(writeBrowserPolicyV1(empty, path), /符号链接/u);
	assert.equal(await readFile(target, "utf8"), "{}", "符号链接目标不能被改写");
});

test.after(async () => { await rm(workspace, { recursive: true, force: true }); });
