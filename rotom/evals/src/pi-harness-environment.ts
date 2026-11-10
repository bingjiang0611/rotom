/**
 * Process-environment scoping for eval runs, and the per-arm overrides that let one
 * product be compared with and without a feature (optimization plan P1-3/P1-5).
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defaultProductAgentDir } from "./product-runtime.ts";

let environmentQueue: Promise<void> = Promise.resolve();

/** Run with environment overrides; runs are serialized so arms never share a mutated env. */
export async function withExclusiveEnvironment<T>(
	overrides: Readonly<Record<string, string | undefined>>,
	run: () => Promise<T>,
): Promise<T> {
	let release = () => {};
	const previous = environmentQueue;
	environmentQueue = new Promise<void>((resolveQueue) => {
		release = resolveQueue;
	});
	await previous;
	const original = new Map<string, string | undefined>();
	try {
		for (const [name, value] of Object.entries(overrides)) {
			original.set(name, process.env[name]);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		return await run();
	} finally {
		for (const [name, value] of original) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		release();
	}
}

export type ArmOverrides = { excludedResourceKeys: string[]; environment: Record<string, string> };

const ARM_ENV_NAME = /^ROTOM_[A-Z0-9_]+$/u;
// The arm selectors themselves and identity overrides must not be rewritten per arm.
const RESERVED = new Set(["ROTOM_PI", "ROTOM_NODE", "ROTOM_VERIFIED_PI_EXECUTABLE"]);

function canonical(path: string): string {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
}

/**
 * Overrides for the arm whose product directory is `ROTOM_EVAL_BASELINE_PRODUCT`:
 * `ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES` (comma-separated product resource keys, e.g.
 * `extension:coding-policy`) and `ROTOM_EVAL_BASELINE_ENV` (a JSON object of `ROTOM_*`
 * string values, e.g. `{"ROTOM_EVIDENCE_REDUCER":"0"}`). A same-commit comparison uses
 * a second checkout as the baseline directory; the candidate arm is never touched.
 */
export function baselineArmOverrides(productAgentDir: string, env: NodeJS.ProcessEnv = process.env): ArmOverrides {
	const keys = (env.ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES ?? "").split(",").map((key) => key.trim()).filter(Boolean);
	const rawEnv = env.ROTOM_EVAL_BASELINE_ENV?.trim();
	if (keys.length === 0 && !rawEnv) return { excludedResourceKeys: [], environment: {} };
	const baseline = env.ROTOM_EVAL_BASELINE_PRODUCT?.trim();
	if (!baseline) throw new Error("Baseline arm overrides require ROTOM_EVAL_BASELINE_PRODUCT.");
	// Suites default the candidate to this checkout's product when it is not set.
	const candidate = env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || defaultProductAgentDir(env);
	if (canonical(candidate) === canonical(baseline)) {
		throw new Error("Baseline arm overrides need a baseline directory distinct from the candidate; use a second checkout of the same commit.");
	}
	let environment: Record<string, string> = {};
	if (rawEnv) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawEnv);
		} catch {
			throw new Error("ROTOM_EVAL_BASELINE_ENV must be a JSON object.");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ROTOM_EVAL_BASELINE_ENV must be a JSON object.");
		for (const [name, value] of Object.entries(parsed)) {
			if (!ARM_ENV_NAME.test(name) || RESERVED.has(name) || name.startsWith("ROTOM_EVAL_")) throw new Error(`ROTOM_EVAL_BASELINE_ENV may not set ${name}.`);
			if (typeof value !== "string") throw new Error(`ROTOM_EVAL_BASELINE_ENV value for ${name} must be a string.`);
		}
		environment = parsed as Record<string, string>;
	}
	if (canonical(productAgentDir) !== canonical(baseline)) return { excludedResourceKeys: [], environment: {} };
	return { excludedResourceKeys: keys, environment };
}
