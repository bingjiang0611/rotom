import assert from "node:assert/strict";
import test from "node:test";
import {
	buildContinuePrompt,
	buildGoalContextPrompt,
	buildGoalPrompt,
	buildGoalSystemPrompt,
	buildObjectiveUpdatedPrompt,
	buildResumePrompt,
	buildWaitingResumePrompt,
	REVIEW_REJECTION_GUIDANCE,
	type GoalPromptContext,
} from "../src/prompts.js";
import { createGoalContextContract } from "../src/goal-contract.js";

const goal: GoalPromptContext = {
	id: "goal-prompt-test",
	text: "Deliver the full workflow <not an MVP> & verify it.",
	status: "active",
	iteration: 1,
	tokensUsed: 0,
	startedAt: 0,
	updatedAt: 0,
	timeUsedSeconds: 0,
	baselineTokens: 0,
};

// These assert the injected contract, not a live model's compliance with it.
const prompts = {
	start: buildGoalPrompt(goal),
	update: buildObjectiveUpdatedPrompt(goal),
	resume: buildResumePrompt(goal, "paused"),
	waitResume: buildWaitingResumePrompt(goal, "Awaiting external event"),
	system: buildGoalSystemPrompt(goal),
	context: buildGoalContextPrompt(goal),
	continue: buildContinuePrompt(goal, "marker", "Inspect current evidence"),
	contract: createGoalContextContract(goal).content,
};

for (const [entry, prompt] of Object.entries(prompts)) {
	test(`${entry}: clarify from evidence without shrinking or rewriting the objective`, () => {
		assert.match(prompt, /deliverable, completion evidence, and authorized write scope/);
		assert.match(prompt, /Resolve gaps by inspecting project scripts, documentation, and current state first/);
		assert.match(prompt, /unfamiliar domains, find authoritative rules and examples rather than inventing/);
		assert.match(prompt, /low-risk, reversible implementation choices, state the assumption and proceed/);
		assert.match(prompt, /Do not silently rewrite the objective, reduce it to an MVP, or add acceptance requirements/);
		assert.match(prompt, /preserve existing explicit authorization without asking for it again/);
		assert.ok(prompt.includes("<goal_objective>\nDeliver the full workflow &lt;not an MVP&gt; &amp; verify it.\n</goal_objective>"));
	});

	test(`${entry}: automatic continuation preserves authorization and decision boundaries`, () => {
		assert.match(prompt, /ask before the affected action with ask_user_question when available/);
		assert.match(prompt, /That tool waits for the answer before the run can finish/);
		assert.match(prompt, /call goal_blocked with needs_user_decision: true/);
		assert.match(prompt, /does not require three blocker turns/);
		assert.match(prompt, /resume never grants missing authorization/);
		assert.match(prompt, /Never pause on your own initiative/);
		assert.match(prompt, /Ending a turn does not pause the goal; Goal continues automatically/);
		assert.match(prompt, /goal_continue is optional planning metadata/);
		assert.match(prompt, /If you omit it, Goal still continues automatically/);
		assert.doesNotMatch(prompt, /so Goal pauses/);
		assert.doesNotMatch(prompt, /end without goal_continue/);
	});

	test(`${entry}: evidence-driven retries preserve unknown outcomes and completion requirements`, () => {
		assert.match(prompt, /distinguish confirmed failure, still-running work, and unknown outcome/);
		assert.match(prompt, /new evidence or a specific testable hypothesis, within existing tool retry limits/);
		assert.match(prompt, /Do not mechanically repeat unchanged attempts or switch tools to bypass permissions or safety boundaries/);
		assert.match(prompt, /external write with an unknown outcome, use read-only checks of the same target/);
		assert.match(prompt, /never replay it merely because it timed out or lacked success evidence/);
		assert.match(prompt, /outcome remains unknown, continue other unfinished requirements/);
		assert.match(prompt, /three-turn minimum gates recurring external blockers only/);
		assert.match(prompt, /same blocker persists for three goal turns and no other useful work remains, call goal_blocked/);
		assert.match(prompt, /Never repeat a failed check, reread unchanged logs, or manufacture continuation turns merely to reach the blocker count/);
		assert.match(prompt, /An unchanged external prerequisite is not a new retry hypothesis/);
		assert.match(prompt, /Only call the goal_complete tool after evidence proves every requirement/);
		assert.match(prompt, /missing or uninspectable requirements remain unverified/);
		assert.doesNotMatch(prompt, /If a tool fails, try reasonable alternatives instead of yielding early/);
	});

	test(`${entry}: rejection permits evidenced repairs, never replay for proof`, () => {
		assert.ok(prompt.includes(REVIEW_REJECTION_GUIDANCE));
		assert.match(prompt, /Repair only an evidenced defect within existing authorization/);
		assert.match(prompt, /For an evidence gap, gather read-only evidence; never repeat a successful or unknown external write/);
		assert.match(prompt, /no new admissible evidence or justified repair is available, continue with other unfinished requirements/);
		assert.match(prompt, /every remaining requirement depends on unavailable evidence or a user-owned decision, call goal_blocked/);
		assert.doesNotMatch(prompt, /gather stronger evidence and keep working\./);
	});
}
