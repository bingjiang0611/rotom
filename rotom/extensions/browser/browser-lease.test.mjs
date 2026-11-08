import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BROWSER_LEASE_SCOPE_ENV_V1,
	checkBrowserLeaseV1,
	leaseOriginV1,
	loadBrowserLeaseForCallV1,
	materializeBrowserLeaseV1,
	readBrowserLeaseV1,
	widenChildLeasesV1,
} from "./browser-lease.ts";

const ROOT = "session-root";
const TOKEN = "run-abc123";
const ORIGIN = "https://example.test";
const ORIGIN_ENTRY = { origin: ORIGIN, capabilities: ["read", "interact", "devtools", "upload", "download"] };

const scope = (overrides = {}) => JSON.stringify({
	schemaVersion: 1,
	rootSessionId: ROOT,
	origins: [ORIGIN_ENTRY],
	allow: { devtools: false, upload: false, download: false },
	maxTabs: 4,
	keepTabs: false,
	expiresAt: Date.now() + 60_000,
	...overrides,
});

async function privateRelayDir() {
	const base = await mkdtemp(join(tmpdir(), "rotom-lease-"));
	await chmod(base, 0o700);
	return base;
}

test("lease: absent, expired, foreign origin and allow switches all refuse", () => {
	const lease = { token: TOKEN, agentId: TOKEN, rootSessionId: ROOT, origins: [ORIGIN_ENTRY], allow: { devtools: false, upload: false, download: false }, maxTabs: 4, keepTabs: false, expiresAt: 1_000 };
	assert.deepEqual(checkBrowserLeaseV1(undefined, { origin: ORIGIN, capability: "interact", now: 0 }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "interact", reason: "missing" });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: ORIGIN, capability: "interact", now: 1_001 }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "interact", reason: "expired" });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: "https://other.test", capability: "interact", now: 0 }), { ok: false, kind: "needs-approval", origin: "https://other.test", capability: "interact", reason: "origin" });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: ORIGIN, capability: "download", now: 0 }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "download", reason: "capability" });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: ORIGIN, capability: "interact", now: 0 }), { ok: true });
	// The origin alone is not a grant: the entry must name the capability too.
	const readOnly = { ...lease, expiresAt: Date.now() + 60_000, origins: [{ origin: ORIGIN, capabilities: ["read"] }] };
	assert.deepEqual(checkBrowserLeaseV1(readOnly, { origin: ORIGIN, capability: "interact", now: 0 }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "interact", reason: "capability" });
	assert.deepEqual(checkBrowserLeaseV1(readOnly, { origin: ORIGIN, capability: "read", now: 0 }), { ok: true });
	// Only http(s) origins are comparable; everything else has no origin to match.
	assert.equal(leaseOriginV1("about:blank"), undefined);
	assert.equal(leaseOriginV1("file:///etc/passwd"), undefined);
	assert.equal(leaseOriginV1("https://example.test/a/b?q=1"), ORIGIN);
});

test("lease: a child materializes the inherited scope once, then the file is authoritative", async () => {
	const relayDir = await privateRelayDir();
	const scopeEnv = process.env[BROWSER_LEASE_SCOPE_ENV_V1];
	process.env[BROWSER_LEASE_SCOPE_ENV_V1] = scope();
	try {
		const created = await loadBrowserLeaseForCallV1({ relayDir, token: TOKEN, scope: process.env[BROWSER_LEASE_SCOPE_ENV_V1] });
		assert.equal(created?.token, TOKEN);
		assert.equal(created?.agentId, TOKEN, "the lease names the agent it was written for");
		assert.equal(created?.rootSessionId, ROOT);
		assert.deepEqual(created?.origins, [ORIGIN_ENTRY]);

		// The parent widens the lease by rewriting the file; the next check re-reads it.
		const file = join(relayDir, "leases", `${TOKEN}.json`);
		const stored = JSON.parse(await readFile(file, "utf8"));
		assert.equal(stored.kind, "rotom-browser-lease");
		await writeFile(file, JSON.stringify({ ...stored, origins: [ORIGIN_ENTRY, { origin: "https://added.test", capabilities: ["interact"] }] }));
		const widened = await loadBrowserLeaseForCallV1({ relayDir, token: TOKEN, scope: process.env[BROWSER_LEASE_SCOPE_ENV_V1] });
		assert.deepEqual(widened?.origins, [ORIGIN_ENTRY, { origin: "https://added.test", capabilities: ["interact"] }], "the file wins over the inherited scope");
		assert.deepEqual(checkBrowserLeaseV1(widened, { origin: "https://added.test", capability: "interact" }), { ok: true });
	} finally {
		if (scopeEnv === undefined) delete process.env[BROWSER_LEASE_SCOPE_ENV_V1];
		else process.env[BROWSER_LEASE_SCOPE_ENV_V1] = scopeEnv;
	}
});

test("lease: without a scope or token there is no lease to allow anything", async () => {
	const relayDir = await privateRelayDir();
	assert.equal(await loadBrowserLeaseForCallV1({ relayDir, token: TOKEN, scope: undefined }), undefined);
	assert.equal(await loadBrowserLeaseForCallV1({ relayDir, token: undefined, scope: scope() }), undefined);
	assert.equal(await loadBrowserLeaseForCallV1({ relayDir, token: "../../etc/passwd", scope: scope() }), undefined);
	assert.deepEqual(checkBrowserLeaseV1(await readBrowserLeaseV1(relayDir, TOKEN), { origin: ORIGIN, capability: "interact" }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "interact", reason: "missing" });
});

test("lease: malformed, oversized, symlinked and world-readable leases are rejected", async () => {
	const relayDir = await privateRelayDir();
	assert.equal(await materializeBrowserLeaseV1(relayDir, "{", TOKEN), undefined);
	assert.equal(await materializeBrowserLeaseV1(relayDir, scope({ origins: [{ origin: "about:blank", capabilities: ["interact"] }] }), TOKEN), undefined);
	assert.equal(await materializeBrowserLeaseV1(relayDir, scope({ origins: [{ origin: ORIGIN, capabilities: ["write"] }] }), TOKEN), undefined, "未知 capability 一律拒绝");
	assert.equal(await materializeBrowserLeaseV1(relayDir, scope({ maxTabs: -1 }), TOKEN), undefined);
	assert.equal(await materializeBrowserLeaseV1(relayDir, scope({ allow: { devtools: "yes", upload: false, download: false } }), TOKEN), undefined);

	// The pre-capability format (bare origin strings) is read as read-only: it names its
	// origin but grants no capability, so it can never widen into interact.
	const legacy = await materializeBrowserLeaseV1(relayDir, scope({ origins: [ORIGIN] }), "run-legacy");
	assert.deepEqual(legacy?.origins, [{ origin: ORIGIN, capabilities: [] }]);
	assert.deepEqual(checkBrowserLeaseV1(legacy, { origin: ORIGIN, capability: "interact" }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "interact", reason: "capability" });

	const good = await materializeBrowserLeaseV1(relayDir, scope({ origins: [{ origin: "https://ok.test", capabilities: ["interact"] }] }), "run-ok");
	assert.deepEqual(good?.origins, [{ origin: "https://ok.test", capabilities: ["interact"] }]);
	const file = join(relayDir, "leases", "run-ok.json");
	await chmod(file, 0o644);
	assert.equal(await readBrowserLeaseV1(relayDir, "run-ok"), undefined, "a group/world readable lease file is not trusted");

	await chmod(file, 0o600);
	assert.ok(await readBrowserLeaseV1(relayDir, "run-ok"));
	await chmod(join(relayDir, "leases"), 0o755);
	assert.equal(await readBrowserLeaseV1(relayDir, "run-ok"), undefined, "a group/world readable lease directory is not trusted");

	// A symlinked lease file must not redirect reads to another agent's lease.
	await chmod(join(relayDir, "leases"), 0o700);
	await symlink(file, join(relayDir, "leases", "run-link.json"));
	assert.equal(await readBrowserLeaseV1(relayDir, "run-link"), undefined);
});

test("lease: an existing lease is never overwritten by a new scope", async () => {
	const relayDir = await privateRelayDir();
	await materializeBrowserLeaseV1(relayDir, scope({ origins: [{ origin: "https://first.test", capabilities: ["interact"] }] }), TOKEN);
	const second = await materializeBrowserLeaseV1(relayDir, scope({ origins: [{ origin: "https://second.test", capabilities: ["interact"] }] }), TOKEN);
	assert.deepEqual(second?.origins, [{ origin: "https://first.test", capabilities: ["interact"] }]);
});

test("widenChildLeasesV1：只给本 run 的子 lease 加 origin，保留其它字段", async () => {
	const { mkdtemp, mkdir, chmod, writeFile, readFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "rotom-lease-widen-"));
	const relayDir = join(root, "relay");
	const leases = join(relayDir, "leases");
	await mkdir(leases, { recursive: true, mode: 0o700 });
	await chmod(leases, 0o700);
	const write = async (token, rootSessionId, origins) => {
		const file = join(leases, `${token}.json`);
		await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: "rotom-browser-lease", token, agentId: token, rootSessionId, origins, allow: { devtools: false, upload: false, download: false }, maxTabs: 2, keepTabs: false, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
		await chmod(file, 0o600);
	};
	await write("child-a", "root-1", [{ origin: "https://a.test", capabilities: ["read"] }]);
	await write("child-b", "root-1", [{ origin: "https://b.test", capabilities: ["interact"] }]);
	await write("other-run", "root-2", [{ origin: "https://c.test", capabilities: ["interact"] }]);
	const widened = await widenChildLeasesV1({ relayDir, rootSessionId: "root-1", origin: "https://new.test", capability: "interact" });
	assert.deepEqual(widened, { updated: 2, skipped: 1 });
	const a = JSON.parse(await readFile(join(leases, "child-a.json"), "utf8"));
	assert.deepEqual(a.origins, [{ origin: "https://a.test", capabilities: ["read"] }, { origin: "https://new.test", capabilities: ["interact"] }]);
	assert.equal(a.maxTabs, 2);
	assert.equal(a.rootSessionId, "root-1");
	const other = JSON.parse(await readFile(join(leases, "other-run.json"), "utf8"));
	assert.deepEqual(other.origins, [{ origin: "https://c.test", capabilities: ["interact"] }], "别的 run 的 lease 不能被动");
	// 同一 origin 再加别的 capability 是就地合并，不新增条目。
	await widenChildLeasesV1({ relayDir, rootSessionId: "root-1", origin: "https://a.test", capability: "devtools", allow: { devtools: true } });
	const merged = JSON.parse(await readFile(join(leases, "child-a.json"), "utf8"));
	assert.deepEqual(merged.origins, [{ origin: "https://a.test", capabilities: ["read", "devtools"] }, { origin: "https://new.test", capabilities: ["interact"] }]);
	assert.equal(merged.allow.devtools, true);
	// 重复调用不再写入。
	assert.deepEqual(await widenChildLeasesV1({ relayDir, rootSessionId: "root-1", origin: "https://new.test", capability: "interact" }), { updated: 0, skipped: 3 });
	// 非法 origin 不做任何事。
	assert.deepEqual(await widenChildLeasesV1({ relayDir, rootSessionId: "root-1", origin: "file:///etc/passwd", capability: "interact" }), { updated: 0, skipped: 0 });
	const { rm } = await import("node:fs/promises");
	await rm(root, { recursive: true, force: true });
});
