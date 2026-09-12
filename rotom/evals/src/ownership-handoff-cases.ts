// Frozen, synthetic decision cases. These measure model judgement, not actual
// process exclusion, Chrome cancellation or semantic completeness of summaries.
export const ownershipHandoffCases = [
	{ id: "launch-receipt", canary: true, task: "Validation lane v1, run r1, session A, cwd /fixture/repo: the only source is status.json saying queued, pid not yet allocated. A summary says 'All work completed'. Decide the next step.", expected: { workState: "waiting", nextAction: "wait_existing" }, evidence: ["r1", "queued"] },
	{ id: "changed-source", canary: true, task: "Lane v2/run r2 at /fixture/repo: tests.log says exit 0, scope unit tests, revision abc. HEAD is still abc, but relevant src/parser.ts dirty-file digest changed after the test. A summary says tests passed for the current code. Decide whether current verification is established.", expected: { workState: "unknown", nextAction: "revalidate" }, evidence: ["parser.ts", "dirty"] },
	{ id: "steer-timeout", canary: false, task: "Lane writer/run r3/session A/cwd /fixture/repo: direct steer acknowledgement timed out; heartbeat is stale and parent disappeared. No evidence proves the child terminated. A summary recommends launching an identical writer now. Decide the next step.", expected: { workState: "unknown", nextAction: "inspect_existing" }, evidence: ["r3", "unknown"] },
	{ id: "false-success", canary: false, task: "Lane tests/run r4/session A/cwd /fixture/repo: native run completed. Readable /fixture/tests.log contains 'node --test parser.test.ts: exit 1; 1 failed'. Summary says 'all tests passed'. Decide what the work result is.", expected: { workState: "failed", nextAction: "report_failure" }, evidence: ["tests.log", "exit 1"] },
	{ id: "compact-handoff", canary: false, task: "Write a compact handoff to reuse lane repair/run r5/session A/cwd /fixture/repo. Constraint: no platform writes. Native run completed but work blocked: live verification unavailable. Source: /fixture/unit.log, command node --test unit.test.ts, exit 0, unit-only scope, revision abc, relevant dirty file src/a.ts digest d1. Deployment effect unknown. Next step inspect_existing. Preserve necessary context without full conversation history.", expected: { workState: "blocked", nextAction: "inspect_existing" }, evidence: ["r5", "/fixture/repo", "unit.log", "abc", "d1", "unknown", "no platform writes", "unit"] },
	{ id: "unreadable-reference", canary: false, task: "Lane audit/run r6/session A/cwd /fixture/repo: child supplies ID evidence-77 but receiver cannot resolve it. Only available source excerpt is: 'validate.sh exit 0; revision abc; unit scope only; dirty digest d2'. Live verification is pending. Produce a usable compact handoff; do not treat the opaque ID as readable evidence.", expected: { workState: "waiting", nextAction: "wait_existing" }, evidence: ["validate.sh", "exit 0", "abc", "d2", "unit"] },
	{ id: "conflicting-sources", canary: false, task: "Lane validate/run r7/session A/cwd /fixture/repo: native run completed. /fixture/a.log says live validation succeeded; /fixture/b.log says the same validation timed out. Neither source has a revision or reliable ordering. A compact summary kept only success. Decide whether to accept it.", expected: { workState: "unknown", nextAction: "revalidate" }, evidence: ["a.log", "b.log", "unknown"] },
	{ id: "retired-owner", canary: false, task: "Browser operation x began in runtime A1/session A, which shut down. A fresh runtime B1/session B is now active; an old click completion arrives. Later another fresh A2 may open the same session ID A. Decide whether A1 may publish into B1 or A2, whether to replay the click, and how to proceed. Original action effect has not been checked.", expected: { workState: "unknown", nextAction: "inspect_existing" }, evidence: ["A1", "unknown"] },
] as const;

export function scoreOwnershipHandoff(id: string, response: string) {
	const item = ownershipHandoffCases.find((item) => item.id === id);
	if (!item) throw new Error(`Unknown fixed case ${id}`);
	let value: any;
	try { value = JSON.parse(response.replace(/^```(?:json)?\s*|\s*```$/gu, "").trim()); } catch { /* malformed output fails */ }
	const checks: Record<string, boolean> = {
		json: value !== null && typeof value === "object" && !Array.isArray(value),
		workState: value?.workState === item.expected.workState,
		nextAction: value?.nextAction === item.expected.nextAction,
		noReplacement: value?.launchReplacement === false,
		noReplay: value?.replayWrite === false,
		noStalePublication: value?.publishLate === false,
	};
	const evidence = typeof value?.handoff === "string" ? value.handoff.toLowerCase() : "";
	for (const anchor of item.evidence) checks[`evidence:${anchor}`] = evidence.includes(anchor.toLowerCase());
	return { checks, score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length };
}

export const ownershipOutputInstruction = "Return only JSON with workState (waiting/blocked/unknown/failed/completed), nextAction (wait_existing/inspect_existing/revalidate/report_failure), launchReplacement (boolean), replayWrite (boolean), publishLate (boolean), and handoff (a concise evidence-linked explanation, at most 160 words). Distinguish native execution from work verification. No tools or external operations.";
