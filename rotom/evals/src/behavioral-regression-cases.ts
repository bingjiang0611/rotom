// Behavioural regression cases derived from one week of reviewed sessions.
//
// Provenance: five dissatisfaction patterns found by judging rule-hit sessions
// in the private dashboard store. Only the *pattern* is reproduced: workspaces,
// file names, data rows and the credential below are invented, so no session
// text, label or tool argument from the private store enters the repo.
//
// These are behaviour cases, not decision quizzes. Each one gives the agent a
// workspace and real tools, then judges its actual tool calls, files and final
// reply. Prompts describe the task only: they never name the check, so a model
// cannot score by echoing a field called `assertsRunningWithoutCheck`.
//
// Workspace files are written to look like an ordinary small project. No file
// says a word about being invented, and no script describes its own behaviour;
// whoever reads the workspace sees a normal tool, not a task description. The
// source-level note you are reading is the only place that explains intent.
//
// Judging is deterministic and lives here (not in the `.eval.ts` file) so the
// checks can be exercised against synthetic transcripts with no model spend.
// Case definitions are split by family (`behavioral-cases-tools.ts`,
// `behavioral-cases-report.ts`); shared types and helpers live in
// `behavioral-regression-shared.ts`.
import { createJudge } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import type { PiCodingAgentInput } from "./pi-harness.ts";
import type { BehavioralCase, BehavioralCaseId, BehavioralEvidence, BehavioralOutput } from "./behavioral-regression-shared.ts";
import { toolCases } from "./behavioral-cases-tools.ts";
import { reportCases } from "./behavioral-cases-report.ts";

export type { BehavioralCase, BehavioralCaseId, BehavioralEvidence, BehavioralOutput, ToolCallRecord } from "./behavioral-regression-shared.ts";
export { offersNextStep } from "./behavioral-regression-shared.ts";
export { CREDENTIAL_MARKER, REPORT_ROWS, REPORT_TOTAL } from "./behavioral-regression-fixtures.ts";

export const behavioralCases: BehavioralCase[] = [...toolCases, ...reportCases];

export function behavioralCaseFor(id: string): BehavioralCase {
	const found = behavioralCases.find((item) => item.id === id);
	if (!found) throw new Error(`Unknown behavioural case: ${id}`);
	return found;
}

function toEvidence(output: BehavioralOutput): BehavioralEvidence {
	return { response: output.response ?? "", calls: Array.isArray(output.calls) ? output.calls : [], files: output.files ?? {} };
}

/** Deterministic scorer: every check must hold, otherwise the case fails. */
export function scoreBehavioralCase(id: string, output: BehavioralOutput): { passed: boolean; checks: Record<string, boolean> } {
	const item = behavioralCaseFor(id);
	const checks = { caseIdentity: output.caseId === id, ...item.checks(toEvidence(output)) };
	return { passed: Object.values(checks).every(Boolean), checks };
}

export function behavioralJudge(item: BehavioralCase) {
	return createJudge<PiCodingAgentInput, BehavioralOutput & JsonValue>(`BehavioralRegression-${item.id}`, ({ output }) => {
		const { passed, checks } = scoreBehavioralCase(item.id, output as unknown as BehavioralOutput);
		return {
			score: passed ? 1 : 0,
			metadata: {
				rationale: JSON.stringify(checks),
				output: { checks, toolCallCount: (output as unknown as BehavioralOutput).toolCallCount ?? 0 } as JsonValue,
			},
		};
	});
}
