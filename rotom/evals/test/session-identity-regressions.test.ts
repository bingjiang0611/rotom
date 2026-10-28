import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertIdentityRead, distractorId, identityCases, identityFixtureFiles, scoreIdentity, type IdentityCase, type IdentityOutput } from "../src/session-identity-regressions.ts";

function completed(item: IdentityCase): IdentityOutput {
	return {
		response: JSON.stringify({ status: item.expectedStatus, piSessionId: item.expectedSessionId, evidenceFiles: ["session-refs.json", "native-sessions.json"], reason: "Fixture evidence supports this outcome." }),
		stopReason: "stop", fixturesIntact: true, toolErrors: 0,
		reads: Object.entries(identityFixtureFiles).map(([file, content]) => ({ file, content, isError: false })),
	};
}
function answer(output: IdentityOutput, patch: Record<string, unknown>): IdentityOutput {
	return { ...output, response: JSON.stringify({ ...JSON.parse(output.response), ...patch }) };
}

describe("identity acceptance is independent of model assertions", () => {
	for (const item of identityCases) it(`accepts grounded ${item.expectedStatus}`, () => {
		expect(scoreIdentity(item, completed(item)).score).toBe(1);
	});
	const item = identityCases[0];
	it("keeps recovered blocked-read errors separate from grounded correctness", () => {
		expect(scoreIdentity(item, { ...completed(item), toolErrors: 1 }).score).toBe(1);
	});
	const mutations: Array<[string, (output: IdentityOutput) => IdentityOutput]> = [
		["current-process ID (historical failure)", (output) => answer(output, { piSessionId: distractorId })],
		["canonical instead of native ID", (output) => answer(output, { piSessionId: "fixture-ref-alpha" })],
		["claimed reads without tool completion", (output) => ({ ...output, reads: [] })],
		["failed native reads", (output) => ({ ...output, reads: output.reads.map((read) => ({ ...read, isError: true })) })],
		["partial read content", (output) => ({ ...output, reads: output.reads.map((read) => ({ ...read, content: "truncated" })) })],
		["fabricated citation", (output) => answer(output, { evidenceFiles: ["session-refs.json", "native-sessions.json", "invented.json"] })],
		["missing citation", (output) => answer(output, { evidenceFiles: ["native-sessions.json"] })],
		["changed fixtures", (output) => ({ ...output, fixturesIntact: false })],
		["aborted completion", (output) => ({ ...output, stopReason: "aborted" })],
		["malformed JSON", (output) => ({ ...output, response: "success" })],
		["missing explanation", (output) => answer(output, { reason: "" })],
	];
	for (const [name, mutate] of mutations) it(`rejects ${name}`, () => {
		expect(scoreIdentity(item, mutate(completed(item))).score).toBe(0);
	});
	for (const unknown of identityCases.slice(1)) it(`rejects invented identity for ${unknown.expectedStatus}`, () => {
		expect(scoreIdentity(unknown, answer(completed(unknown), { piSessionId: distractorId })).score).toBe(0);
	});
});

describe("native read admission", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "identity-regression-test-"));
		for (const [file, body] of Object.entries(identityFixtureFiles)) await writeFile(join(root, file), body, { mode: 0o400 });
	});
	afterEach(async () => { await rm(root, { recursive: true, force: true }); });
	it("admits relative and absolute complete fixture reads", async () => {
		expect(await assertIdentityRead(root, "read", { path: "native-sessions.json" })).toBe("native-sessions.json");
		expect(await assertIdentityRead(root, "read", { path: join(root, "session-refs.json") })).toBe("session-refs.json");
		expect(await assertIdentityRead(root, "read", { path: "native-sessions.json", offset: 1, limit: 2000 })).toBe("native-sessions.json");
	});
	for (const [name, tool, input] of [
		["write tools", "bash", { command: "true" }],
		["parent traversal", "read", { path: "../outside" }],
		["host paths", "read", { path: "/etc/passwd" }],
		["unlisted paths", "read", { path: "expected.json" }],
		["partial reads", "read", { path: "native-sessions.json", limit: 1 }],
	] as const) it(`rejects ${name}`, async () => {
		await expect(assertIdentityRead(root, tool, input)).rejects.toThrow();
	});
	it("rejects changed bytes", async () => {
		const file = join(root, "native-sessions.json");
		await chmod(file, 0o600);
		await writeFile(file, "{}");
		await expect(assertIdentityRead(root, "read", { path: file })).rejects.toThrow("changed");
	});
	it("rejects symlinks even to another allowed fixture", async () => {
		const file = join(root, "native-sessions.json");
		await rm(file);
		await symlink(join(root, "session-refs.json"), file);
		await expect(assertIdentityRead(root, "read", { path: file })).rejects.toThrow("canonical");
	});
	it("propagates a missing fixture rather than authorizing a read", async () => {
		await rm(join(root, "native-sessions.json"));
		await expect(assertIdentityRead(root, "read", { path: "native-sessions.json" })).rejects.toMatchObject({ code: "ENOENT" });
	});
});
