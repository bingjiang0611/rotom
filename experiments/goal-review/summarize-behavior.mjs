// Regrade saved synthetic evidence without model calls or rewriting raw results.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { behaviorCases, gradeBehavior, requestsDecision } from "./behavior.mjs";

const [root, output] = process.argv.slice(2);
assert(root && output, "usage: summarize-behavior.mjs <matrix-root> <output.json>");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const report = { scope: "fixed synthetic Goal behavior matrix; no real external writes", model: "qoder/ultimate", rows: [], totals: {} };
for (const variant of ["baseline", "candidate"]) {
	for (const repetition of readdirSync(join(root, variant)).sort()) {
		const directory = join(root, variant, repetition);
		for (const file of readdirSync(directory).filter((f) => /^behavior-\d+\.json$/.test(f)).sort()) {
			const raw = JSON.parse(readFileSync(join(directory, file), "utf8"));
			if (!raw.ended) {
				(report.pending ??= []).push({ variant, repetition, started: raw.started });
				continue;
			}
			if (raw.cases.length !== 1) {
				report.rows.push({ variant, repetition, status: raw.status, errorClass: raw.errorClass, errorDigest: raw.errorDigest, network: raw.network });
				continue;
			}
			const row = raw.cases[0], c = behaviorCases.find((c) => c.id === row.id);
			assert(c, "unknown case");
			assert(!raw.reviewSourceOverride, "source overrides are not product matrix evidence");
			assert.equal(raw.model, report.model);
			const sessions = readdirSync(directory, { withFileTypes: true }).filter((f) => f.isDirectory() && f.name.startsWith(`${c.id}-`));
			assert.equal(sessions.length, 1, "each case/repetition must have one native session directory");
			let evidence;
			for (const dir of sessions) {
				const base = join(directory, dir.name), sessionDir = join(base, "control/sessions");
				for (const session of readdirSync(sessionDir)) {
					const entries = readFileSync(join(sessionDir, session), "utf8").trim().split("\n").map(JSON.parse);
					const text = entries.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")).filter(Boolean).at(-1) ?? "";
					if (hash(text) === row.finalTextHash) {
						// The single case directory plus digest binds even an empty final
						// response; /goal's existing argument parser normalizes quotes.
						const objective = entries.find((e) => e.type === "custom" && e.customType === "goal-state" && e.data.goal)?.data.goal.text;
						assert.equal(typeof objective, "string");
						evidence = { cwd: join(base, "project"), text, objectiveTextMatches: objective === c.objective, objectiveSHA256: hash(objective) };
					}
				}
			}
			assert(evidence, `missing native evidence for ${variant}/${repetition}/${c.id}`);
			const question = requestsDecision(evidence.text);
			const verdict = gradeBehavior(c, {
				goal: row.status === "cleared" ? null : { status: row.status, iteration: row.iteration },
				fixture: { counts: () => row.counts, events: row.events }, cwd: evidence.cwd,
				tools: row.tools, question, reviews: row.reviews.map((r) => r.status), timedOut: row.timedOut, modelError: row.modelError,
			});
			report.rows.push({ variant, repetition, goalVersion: raw.goalVersion, objectiveRoundTripVerified: raw.objectiveRoundTripVerified === true, objectiveTextMatches: evidence.objectiveTextMatches, objectiveSHA256: evidence.objectiveSHA256, promptsHash: raw.promptsHash, reviewerHash: raw.reviewerHash, harnessHashes: raw.harnessHashes, started: raw.started, network: raw.network, ...row, originalPass: row.pass, ...verdict, regraded: verdict.pass !== row.pass });
		}
	}
}
const identities = report.rows.filter((r) => r.id).map((r) => `${r.variant}/${r.repetition}/${r.id}`);
assert.equal(new Set(identities).size, identities.length, "duplicate fixture invocation must not silently count as an independent repetition");
for (const variant of ["baseline", "candidate"]) {
	const rows = report.rows.filter((r) => r.variant === variant);
	report.totals[variant] = {
		cases: rows.length, passed: rows.filter((r) => r.pass).length, corePassed: rows.filter((r) => r.corePass).length,
		reviewUnknown: rows.filter((r) => r.reviews?.some((v) => v.status === "unknown")).length,
		infrastructureFailures: rows.filter((r) => r.modelError || r.timedOut || !r.id).length,
		modelDispatches: rows.reduce((n, r) => n + r.network.model, 0),
		reportedTokens: rows.reduce((n, r) => n + (r.usage?.parentReportedTokens ?? 0) + (r.reviews ?? []).reduce((n, v) => n + v.reportedTokens, 0), 0),
		billableCreditsPartial: rows.reduce((n, r) => n + (r.usage?.credits.credits ?? 0), 0),
		unknownCreditObservations: rows.reduce((n, r) => n + (r.usage?.credits.unknown ?? 0), 0),
		elapsedMs: rows.reduce((n, r) => n + (r.elapsedMs ?? 0), 0), usd: null,
	};
}
writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report.totals));
