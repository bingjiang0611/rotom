import { afterEach, expect, it, vi } from "vitest";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";

const internal = [
	"PI_SUBAGENTS_EXECUTION_SCOPE", "PI_SUBAGENTS_TEMP_ROOT", "PI_SUBAGENT_MAX_SPAWNS_PER_SESSION",
	"ROTOM_VERIFIED_PI_EXECUTABLE", "ROTOM_VERIFIED_PI_VERSION", "ROTOM_DEFERRED_DEFAULT_SURFACE",
	"ROTOM_SUBAGENT_QODER_EXTENSION",
];
afterEach(() => vi.unstubAllEnvs());

it("bash commands cannot inherit host internals; ordinary env and host values remain intact", async () => {
	for (const name of internal) vi.stubEnv(name, "internal-fixture");
	vi.stubEnv("ROTOM_REVIEW_USER_ENV", "user-value");
	const result = await createBashTool(process.cwd()).execute("env-check", { command: "env" });
	const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	for (const name of internal) {
		expect(output).not.toContain(name + "=");
		expect(process.env[name]).toBe("internal-fixture");
	}
	expect(output).toContain("ROTOM_REVIEW_USER_ENV=user-value");
});

it("explicit spawn-hook environments are sanitized too", async () => {
	const env = { ...process.env, ...Object.fromEntries(internal.map((name) => [name, "fixture"])) };
	let output = "";
	const result = await createLocalBashOperations().exec("env", process.cwd(), {
		env, onData: (data) => { output += data.toString(); },
	});
	expect(result.exitCode).toBe(0);
	for (const name of internal) expect(output).not.toContain(name + "=");
	expect(env.PI_SUBAGENTS_EXECUTION_SCOPE).toBe("fixture");
});
