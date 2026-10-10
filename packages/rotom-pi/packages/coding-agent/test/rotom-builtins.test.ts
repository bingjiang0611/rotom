import { afterEach, expect, test, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

for (const [version, nativeCodemode] of [["", true], ["0.1.13", false]] as const) {
	test(`built-in inventory: ${version ? "product wrapper" : "standalone Pi"} owns Codemode, built-in MCP registered`, async () => {
		vi.resetModules();
		vi.stubEnv("ROTOM_PRODUCT_VERSION", version);
		const { builtInExtensions } = await import("../src/extensions/index.ts");
		const names = builtInExtensions.map(extension => typeof extension === "function" ? undefined : extension.name);
		expect(names.includes("codemode")).toBe(nativeCodemode);
		expect(names).toContain("mcp");
	});
}
