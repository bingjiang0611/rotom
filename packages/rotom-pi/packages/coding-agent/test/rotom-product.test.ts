import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../src/core/session-manager.ts";
import { checkForNewRotomVersion, getRotomVersion, selectRotomRelease } from "../src/utils/rotom-product.ts";

const release = (tag_name: string, draft = false) => ({ tag_name, draft });
beforeEach(() => {
	for (const key of ["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "ROTOM_SKIP_VERSION_CHECK"]) vi.stubEnv(key, "");
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("rotom product metadata", () => {
	it("accepts an exact version, not arbitrary terminal text", () => {
		for (const value of ["", "v0.1.0", "0.1.0\n", "latest", "\x1b[31m0.1.0"]) {
			vi.stubEnv("ROTOM_PRODUCT_VERSION", value);
			expect(getRotomVersion()).toBeUndefined();
		}
		vi.stubEnv("ROTOM_PRODUCT_VERSION", "0.1.0-alpha.11");
		expect(getRotomVersion()).toBe("0.1.0-alpha.11");
	});

	it("compares numeric alpha versions, ignores drafts/malformed tags and never downgrades", () => {
		const releases = [
			release("v0.1.0-alpha.9"),
			release("v0.1.0-alpha.12"),
			release("9.0.0", true),
			release("bad-tag"),
			null,
		];
		expect(selectRotomRelease(releases, "0.1.0-alpha.11")).toEqual({ version: "0.1.0-alpha.12" });
		expect(selectRotomRelease(releases, "0.1.0-alpha.12")).toBeUndefined();
		expect(selectRotomRelease([], "0.1.0-alpha.11")).toBeUndefined();
		expect(selectRotomRelease({ message: "rate limited" }, "0.1.0")).toBeUndefined();
		expect(selectRotomRelease(releases, "bad")).toBeUndefined();
	});

	it("stable installs do not opt into prereleases; alpha installs can graduate to stable", () => {
		const releases = [release("v0.2.0-alpha.1"), release("v0.1.0")];
		expect(selectRotomRelease(releases, "0.1.0")).toBeUndefined();
		expect(selectRotomRelease([{ ...release("v0.2.0"), prerelease: true }], "0.1.0")).toBeUndefined();
		expect(selectRotomRelease([release("v0.1.0")], "0.1.0-alpha.11")).toEqual({ version: "0.1.0" });
	});
});

describe("rotom runtime branding", () => {
	it("uses the public rotom command while preserving Pi configuration environment names", async () => {
		vi.stubEnv("ROTOM_PRODUCT_VERSION", "0.1.0-alpha.11");
		vi.resetModules();
		const { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } = await import("../src/config.ts");
		expect({ APP_NAME, APP_TITLE, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR }).toEqual({
			APP_NAME: "rotom",
			APP_TITLE: "rotom",
			CONFIG_DIR_NAME: ".pi",
			ENV_AGENT_DIR: "PI_CODING_AGENT_DIR",
			ENV_SESSION_DIR: "PI_CODING_AGENT_SESSION_DIR",
		});

		const root = mkdtempSync(join(tmpdir(), "rotom-resume-command-"));
		const sessionFile = join(root, "session.jsonl");
		writeFileSync(sessionFile, "\n");
		const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		try {
			const { formatResumeCommand } = await import("../src/modes/interactive/interactive-mode.ts");
			const sessionManager = {
				isPersisted: () => true,
				getSessionFile: () => sessionFile,
				getSessionId: () => "test-session",
				usesDefaultSessionDir: () => true,
			} as unknown as SessionManager;
			expect(formatResumeCommand(sessionManager)).toBe("rotom --session test-session");
		} finally {
			if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("rotom release check", () => {
	it("makes one credential-free rotom request, not a Pi or npm version request", async () => {
		const fetchMock = vi.fn(async () => Response.json([release("v0.1.0-alpha.12")]));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewRotomVersion("0.1.0-alpha.11")).resolves.toEqual({ version: "0.1.0-alpha.12" });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/bingjiang0611/rotom/releases?per_page=20",
			expect.objectContaining({
				headers: { accept: "application/vnd.github+json", "User-Agent": "rotom/0.1.0-alpha.11" },
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it.each(["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "ROTOM_SKIP_VERSION_CHECK"])("respects %s", async (key) => {
		vi.stubEnv(key, "1");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewRotomVersion("0.1.0-alpha.11")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		new Response("rate limited", { status: 403 }),
		new Response("not json"),
		new Response("x".repeat(256 * 1024 + 1)),
	])("ignores unavailable/malformed/oversize metadata", async (response) => {
		const fetchMock = vi.fn(async () => response);
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewRotomVersion("0.1.0-alpha.11")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("does not retry network failure or timeout", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("timeout"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewRotomVersion("0.1.0-alpha.11")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
