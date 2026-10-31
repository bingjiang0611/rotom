import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reviewEvidence } from "../../../packages/rotom-goal/src/reviewer.ts";
import type { PiCodingAgentHarnessOptions } from "./pi-harness.ts";
import { latestAssistantResponse } from "./pi-harness-lifecycle.ts";
import { reviewStopping } from "./end-review.ts";

export function assertBundledReviewer(product: string): void {
	const source = readFileSync(new URL("../../../packages/rotom-goal/src/reviewer.ts", import.meta.url), "utf8");
	const bundled = readFileSync(join(product, "extensions/third-party/node_modules/@narumitw/pi-goal/src/reviewer.ts"), "utf8");
	if (source !== bundled) throw new Error("Reviewer source differs from the product's installed reviewer.");
}

async function snapshot(workspace: string, files: string[]): Promise<string> {
	return JSON.stringify(await Promise.all(files.map(async file => {
		try { return await readFile(join(workspace, file), "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	})));
}

// Shared by the two existing native suites. This is a shadow observation, not
// an automatic-continuation controller: rejected/unknown never queues work.
export function createStoppingShadow(input: {
	product: string;
	tasks: string[];
	files: string[];
	fixturesIntact: (workspace: string) => Promise<boolean>;
	latestVerification: () => string | undefined;
}) {
	assertBundledReviewer(input.product);
	let api: ExtensionAPI;
	let ctx: ExtensionContext;
	const reviewed = new Set<number>();
	const extension = (pi: ExtensionAPI) => {
		api = pi;
		reviewed.clear();
		pi.on("before_agent_start", (_event, context) => { ctx = context; });
	};
	const continuePrompt: NonNullable<PiCodingAgentHarnessOptions["continuePrompt"]> = async ({ session, stepIndex, signal }) => {
		if (reviewed.has(stepIndex)) throw new Error("Shadow review cannot replay an already-reviewed segment.");
		reviewed.add(stepIndex);
		const before = await snapshot(ctx.cwd, input.files);
		const immutableFilesMatchFrozenSource = await input.fixturesIntact(ctx.cwd);
		if (!immutableFilesMatchFrozenSource) throw new Error("Shadow fixture integrity preflight failed.");
		const evidence = JSON.stringify({
			nativeRecords: reviewEvidence(session.sessionManager.getBranch()),
			latestAdmittedSuccessfulVerification: input.latestVerification() ?? null,
			harnessPreflight: { immutableFilesMatchFrozenSource, scope: "protected fixture files only; mutable configuration correctness is not assessed" },
		});
		const startedAt = performance.now();
		const result = await reviewStopping(ctx, api, signal ?? new AbortController().signal, {
			task: input.tasks.slice(0, stepIndex + 1).join("\n\n"),
			claim: latestAssistantResponse(session, 0), evidence, requiredFiles: input.files,
		});
		const unchanged = before === await snapshot(ctx.cwd, input.files);
		api.appendEntry("eval-end-review-shadow-v1", { stepIndex, ...result, unchanged, durationMs: performance.now() - startedAt, automaticContinuation: false });
		if (!unchanged) throw new Error("Read-only review changed fixture state.");
		return undefined;
	};
	return { extension, continuePrompt };
}
