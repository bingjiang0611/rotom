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
} from "./browser-lease.ts";

const ROOT = "session-root";
const TOKEN = "run-abc123";
const ORIGIN = "https://example.test";

const scope = (overrides = {}) => JSON.stringify({
	schemaVersion: 1,
	rootSessionId: ROOT,
	origins: [ORIGIN],
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
	const lease = { token: TOKEN, agentId: TOKEN, rootSessionId: ROOT, origins: [ORIGIN], allow: { devtools: false, upload: false, download: false }, maxTabs: 4, keepTabs: false, expiresAt: 1_000 };
	assert.deepEqual(checkBrowserLeaseV1(undefined, { origin: ORIGIN, capability: "open", now: 0 }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "open", reason: "missing" });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: ORIGIN, capability: "open", now: 1_001 }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "open", reason: "expired" });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: "https://other.test", capability: "open", now: 0 }), { ok: false, kind: "needs-approval", origin: "https://other.test", capability: "open", reason: "origin" });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: ORIGIN, capability: "download", now: 0 }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "download", reason: "capability" });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: ORIGIN, capability: "open", now: 0 }), { ok: true });
	assert.deepEqual(checkBrowserLeaseV1(lease, { origin: ORIGIN, capability: "write", now: 0 }), { ok: true });
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
		assert.deepEqual(created?.origins, [ORIGIN]);

		// The parent widens the lease by rewriting the file; the next check re-reads it.
		const file = join(relayDir, "leases", `${TOKEN}.json`);
		const stored = JSON.parse(await readFile(file, "utf8"));
		assert.equal(stored.kind, "rotom-browser-lease");
		await writeFile(file, JSON.stringify({ ...stored, origins: [ORIGIN, "https://added.test"] }));
		const widened = await loadBrowserLeaseForCallV1({ relayDir, token: TOKEN, scope: process.env[BROWSER_LEASE_SCOPE_ENV_V1] });
		assert.deepEqual(widened?.origins, [ORIGIN, "https://added.test"], "the file wins over the inherited scope");
		assert.deepEqual(checkBrowserLeaseV1(widened, { origin: "https://added.test", capability: "open" }), { ok: true });
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
	assert.deepEqual(checkBrowserLeaseV1(await readBrowserLeaseV1(relayDir, TOKEN), { origin: ORIGIN, capability: "open" }), { ok: false, kind: "needs-approval", origin: ORIGIN, capability: "open", reason: "missing" });
});

test("lease: malformed, oversized, symlinked and world-readable leases are rejected", async () => {
	const relayDir = await privateRelayDir();
	assert.equal(await materializeBrowserLeaseV1(relayDir, "{", TOKEN), undefined);
	assert.equal(await materializeBrowserLeaseV1(relayDir, scope({ origins: ["about:blank"] }), TOKEN), undefined);
	assert.equal(await materializeBrowserLeaseV1(relayDir, scope({ maxTabs: -1 }), TOKEN), undefined);
	assert.equal(await materializeBrowserLeaseV1(relayDir, scope({ allow: { devtools: "yes", upload: false, download: false } }), TOKEN), undefined);

	const good = await materializeBrowserLeaseV1(relayDir, scope({ origins: ["https://ok.test"] }), "run-ok");
	assert.deepEqual(good?.origins, ["https://ok.test"]);
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
	await materializeBrowserLeaseV1(relayDir, scope({ origins: ["https://first.test"] }), TOKEN);
	const second = await materializeBrowserLeaseV1(relayDir, scope({ origins: ["https://second.test"] }), TOKEN);
	assert.deepEqual(second?.origins, ["https://first.test"]);
});
