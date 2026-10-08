// Emit an allowlisted public result, never native session text or private artifact paths.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { CASES } from "./cases.mjs";

export function summarize(report, reportSha256) {
	const totals = (chains) => {
		const selected = new Set(chains.map((c) => `${c.case}/${c.repetition}/${c.arm}`));
		const requests = report.requests.filter((r) => selected.has(`${r.case}/${r.repetition}/${r.arm}`));
		return {
			chains: chains.length, requests: requests.length,
			reportedTokens: requests.reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0),
			summaryTokens: requests.filter((r) => r.phase === "summary").reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0),
			continuationTokens: requests.filter((r) => r.phase === "continuation").reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0),
			elapsedMs: chains.reduce((n, c) => n + (c.elapsedMs ?? 0), 0),
			toolActions: chains.reduce((n, c) => n + (c.grade?.actions ?? 0), 0),
		};
	};
	const usable = [];
	const pairs = CASES.flatMap((c) => [1, 2].map((repetition) => {
		const baseline = report.chains.find((x) => x.case === c.id && x.repetition === repetition && x.arm === "baseline");
		const candidate = report.chains.find((x) => x.case === c.id && x.repetition === repetition && x.arm === "candidate");
		const comparable = [baseline, candidate].every((x) => x && ["PASS", "FAIL"].includes(x.status));
		if (comparable) usable.push(baseline, candidate);
		return { case: c.id, repetition, baseline: baseline?.status ?? "NOT_RUN", candidate: candidate?.status ?? "NOT_RUN", comparable };
	}));
	return {
		decision: ["REGRESSION", "BLOCKED"].includes(report.status) ? report.status : "INCONCLUSIVE", profile: "fixed synthetic continuation diagnostics", reportSha256,
		configuration: { provider: report.provider, model: report.model, thinking: report.thinking, arms: report.arms, harnessHashes: report.harnessHashes },
		pairs,
		paired: { baseline: totals(usable.filter((c) => c.arm === "baseline")), candidate: totals(usable.filter((c) => c.arm === "candidate")) },
		all: {
			admittedRequests: report.requests.length + report.priorRequests,
			modelDispatches: report.networkModelDispatches + (report.priorInfrastructureAttempt?.modelDispatches ?? 0),
			reportedTokens: report.requests.reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0) + (report.priorInfrastructureAttempt?.reportedTokens ?? 0),
			elapsedMs: report.ended - report.started, usd: null,
			statusCounts: Object.fromEntries(["PASS", "FAIL", "CENSORED", "BLOCKED"].map((s) => [s, report.chains.filter((c) => c.status === s).length])),
			priorHarnessFailedRequests: report.priorRequests,
		},
		limits: ["Not representative SWE tasks or a proof of non-inferiority", "Real model decisions; simulated workspace/service effects", "Censored and blocked slots excluded from paired comparison, not retried", "Reported usage is partial when failed requests report zero; dollars unknown", "No split-turn or two successive generated summaries evaluated"],
	};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const bytes = readFileSync(process.argv[2]);
	console.log(JSON.stringify(summarize(JSON.parse(bytes), createHash("sha256").update(bytes).digest("hex")), null, 2));
}
