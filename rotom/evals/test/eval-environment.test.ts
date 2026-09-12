import { describe, expect, it } from "vitest";
import { prepareEvalChildEnvironment } from "../scripts/eval-environment.mjs";

describe("prepareEvalChildEnvironment", () => {
	it("enables Node env-proxy support when a host proxy is configured", () => {
		const prepared = prepareEvalChildEnvironment({ HTTPS_PROXY: "http://127.0.0.1:7890" });
		expect(prepared.nodeEnvProxy).toBe(true);
		expect(prepared.environment).toMatchObject({
			HTTPS_PROXY: "http://127.0.0.1:7890",
			NODE_USE_ENV_PROXY: "1",
		});
	});

	it("preserves an explicit proxy choice", () => {
		const prepared = prepareEvalChildEnvironment({
			ALL_PROXY: "http://127.0.0.1:7890",
			NODE_USE_ENV_PROXY: "0",
		});
		expect(prepared.nodeEnvProxy).toBe(false);
		expect(prepared.environment.NODE_USE_ENV_PROXY).toBe("0");
	});
});
