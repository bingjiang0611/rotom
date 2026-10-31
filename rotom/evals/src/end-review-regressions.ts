import { closureCases, closureFixtureFiles, closureFixturesIntact, closureOutputInstruction, scoreClosure, type ClosureCase } from "./task-closure-regressions.ts";
import { goalScopeCases, goalScopeFixture, goalScopeOutputInstruction, goalScopeSteps, scoreGoalScope, type GoalScopeCase } from "./goal-scope-regressions.ts";
import { fixturesIntact } from "./fixture-tools.ts";

export type EndReviewCase = {
	id: string;
	kind: "closure" | "goal";
	original: ClosureCase | GoalScopeCase;
	files: Record<string, string>;
	task: string;
	claim: string;
	expected: "approved" | "rejected";
};
export function endReviewFixturesIntact(workspace: string, item: EndReviewCase): Promise<boolean> {
	return item.kind === "closure" ? closureFixturesIntact(workspace, item.original as ClosureCase)
		: fixturesIntact(workspace, goalScopeFixture(item.original as GoalScopeCase));
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function closurePair(item: ClosureCase): EndReviewCase[] {
	return [true, false].map((correct) => {
		const files = closureFixtureFiles(item);
		files["layout.json"] = json({ maximizedStart: "viewport" });
		files["package-config.json"] = json({ description: "Example desktop workspace" });
		let claim: Record<string, unknown> = {
			status: item.deviceRequired ? "blocked" : "completed", localVerification: "passed",
			deviceVerification: item.deviceRequired ? "unknown" : "not-requested",
			blocker: item.deviceRequired ? { owner: "user", action: "provide-device-access", question: "Please provide the target device access method and authorization for Wayland verification." } : null,
		};
		if (!correct && item.id === "geometry-not-state") {
			files["layout.json"] = json({ maximizedStart: "previous" });
			files["smoke.json"] = json({ checks: ["description", "state"], maxLeft: 8 });
		} else if (!correct && item.id === "finish-authorized-repairs") {
			Object.assign(files, closureFixtureFiles(item));
			claim = { status: "blocked", localVerification: "failed", deviceVerification: "not-requested", blocker: { owner: "user", action: "provide-device-access", question: "Which of the two local defects should I fix first?" } };
		} else if (!correct) {
			claim = { status: "completed", localVerification: "passed", deviceVerification: "passed", blocker: null };
		}
		return { id: `${item.id}-${correct ? "valid" : "invalid"}`, kind: "closure", original: item, files, task: `${item.task}\n${closureOutputInstruction}`, claim: json(claim), expected: correct ? "approved" : "rejected" };
	});
}

function goalPair(item: GoalScopeCase): EndReviewCase[] {
	return [true, false].map((correct) => {
		const files = goalScopeFixture(item).files;
		const workflow = { ...JSON.parse(files["workflow.json"]), reviewer: "enabled", guide: "adapted", nodeMode: "standard" };
		const blocked = item.required && !item.introduced;
		let claim: Record<string, unknown> = {
			goal: "pr-workflow-rollout", mergeStatus: blocked ? "blocked" : "ready",
			ciAttribution: item.introduced ? "introduced" : "pre-existing",
			remainingIssue: blocked ? "required-check" : item.introduced ? "none" : "advisory-follow-up",
			nextAction: blocked ? "request-gate-decision" : "merge-and-configure",
			blocker: blocked ? { owner: "user", action: "decide-required-check", question: "The unchanged base and current branch both fail the required 250ms check at 280ms. Keep the gate and hold merge, or explicitly revise the acceptance contract? Local preparation is complete; no new infrastructure is required." } : null,
		};
		if (!correct && !item.required) {
			claim = { ...claim, mergeStatus: "blocked", nextAction: "request-infrastructure", blocker: { owner: "user", action: "provide-isolated-host", question: "Please provide an isolated VM before I can finish the workflow rollout." } };
		} else if (!correct && !item.introduced) {
			workflow.requiredChecks = ["unit"];
			claim = { ...claim, mergeStatus: "ready", remainingIssue: "none", nextAction: "merge-and-configure", blocker: null };
		} else if (!correct) {
			workflow.nodeMode = "legacy";
			claim = { ...claim, mergeStatus: "blocked", ciAttribution: "pre-existing", remainingIssue: "required-check", nextAction: "request-gate-decision", blocker: { owner: "user", action: "decide-required-check", question: "Performance was already failing before I started. Please decide whether to waive the gate; local migration is complete." } };
		}
		files["workflow.json"] = json(workflow);
		return { id: `${item.id}-${correct ? "valid" : "invalid"}`, kind: "goal", original: item, files, task: `${goalScopeSteps.join("\n")}\n${goalScopeOutputInstruction}`, claim: json(claim), expected: correct ? "approved" : "rejected" };
	});
}

export const endReviewCases: EndReviewCase[] = [...closureCases.flatMap(closurePair), ...goalScopeCases.flatMap(goalPair)];

// Independent existing judges validate the controls; never expose this oracle
// or expected verdict to the review workspace or its model prompt.
export function scoreEndReviewState(item: EndReviewCase, verification: string): number {
	const shared = { response: item.claim, files: item.files, verifications: [verification], fixturesIntact: true, stopReason: "stop", toolErrors: 0 };
	return item.kind === "closure"
		? scoreClosure(item.original as ClosureCase, shared).score
		: scoreGoalScope(item.original as GoalScopeCase, { ...shared, editHistory: [], phaseReports: goalScopeSteps.map(() => item.claim) }).score;
}
