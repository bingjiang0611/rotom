import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../src/core/session-manager.ts";
import { checkForNewRotomVersion, getRotomVersion, selectRotomPackageUpdate } from "../src/utils/rotom-product.ts";

const metadata = (version: string, name = "@bingjiang0611/rotom") => ({ name, version });
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

	it("selects a newer npm package version and never downgrades", () => {
		expect(selectRotomPackageUpdate(metadata("0.1.0-alpha.12"), "0.1.0-alpha.11")).toEqual({
			version: "0.1.0-alpha.12",
		});
		expect(selectRotomPackageUpdate(metadata("0.1.0-alpha.11"), "0.1.0-alpha.12")).toBeUndefined();
		expect(selectRotomPackageUpdate(metadata("bad-tag"), "0.1.0-alpha.11")).toBeUndefined();
		expect(selectRotomPackageUpdate(metadata("0.1.0", "other-package"), "0.1.0-alpha.11")).toBeUndefined();
		expect(selectRotomPackageUpdate({ message: "not found" }, "0.1.0")).toBeUndefined();
		expect(selectRotomPackageUpdate(metadata("0.1.0"), "bad")).toBeUndefined();
	});

	it("stable installs do not opt into prereleases; alpha installs can graduate to stable", () => {
		expect(selectRotomPackageUpdate(metadata("0.2.0-alpha.1"), "0.1.0")).toBeUndefined();
		expect(selectRotomPackageUpdate(metadata("0.1.0"), "0.1.0-alpha.17")).toEqual({ version: "0.1.0" });
	});
});

describe("rotom runtime branding", () => {
	it("keeps the Pi process identity for process-based integrations", async () => {
		vi.stubEnv("ROTOM_PRODUCT_VERSION", "0.1.0-alpha.11");
		vi.resetModules();
		const originalTitle = process.title;
		const originalEmitWarning = process.emitWarning;
		const originalPiCodingAgent = process.env.PI_CODING_AGENT;
		const originalAiAgent = process.env.AI_AGENT;
		try {
			const { setupCli } = await import("../src/cli/setup.ts");
			setupCli();
			expect(process.title).toBe("pi");
			expect(process.env.PI_CODING_AGENT).toBe("true");
			expect(process.env.AI_AGENT).toBe("pi");
		} finally {
			process.title = originalTitle;
			process.emitWarning = originalEmitWarning;
			if (originalPiCodingAgent === undefined) delete process.env.PI_CODING_AGENT;
			else process.env.PI_CODING_AGENT = originalPiCodingAgent;
			if (originalAiAgent === undefined) delete process.env.AI_AGENT;
			else process.env.AI_AGENT = originalAiAgent;
		}
	});

	it("uses the public rotom command while preserving Pi configuration environment names", async () => {
		vi.stubEnv("ROTOM_PRODUCT_VERSION", "0.1.0-alpha.11");
		vi.resetModules();
		const { APP_NAME, APP_TITLE, PROCESS_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } = await import("../src/config.ts");
		expect({ APP_NAME, APP_TITLE, PROCESS_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR }).toEqual({
			APP_NAME: "rotom",
			APP_TITLE: "rotom",
			PROCESS_NAME: "pi",
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

describe("rotom package update check", () => {
	it("makes one credential-free request to the public npm latest endpoint", async () => {
		const fetchMock = vi.fn(async () => Response.json(metadata("0.1.0")));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewRotomVersion("0.1.0-alpha.17")).resolves.toEqual({ version: "0.1.0" });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://registry.npmjs.org/%40bingjiang0611%2Frotom/latest",
			expect.objectContaining({
				headers: { accept: "application/json", "User-Agent": "rotom/0.1.0-alpha.17" },
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
