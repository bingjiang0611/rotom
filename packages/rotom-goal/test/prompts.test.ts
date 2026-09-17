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

	test(`${entry}: authorization pause takes precedence over persistence and blocked threshold`, () => {
		assert.match(prompt, /ask before the affected action.*ask_user_question when available, otherwise in a normal message/);
		assert.match(prompt, /If unresolved, end the run without goal_continue so Goal pauses/);
		assert.match(prompt, /do not call goal_blocked or goal_wait to request permission/);
		assert.match(prompt, /pause is immediate and does not require three blocker turns/);
		assert.match(prompt, /resume never grants missing authorization/);
		assert.match(prompt, /keep working until .*subject to the pause rules in this contract/);
		assert.match(prompt, /Before yielding with authorized runnable work remaining and no required pause/);
		assert.match(prompt, /Use goal_blocked only at a true impasse after the same blocker recurs for at least three consecutive goal turns/);
		assert.doesNotMatch(prompt, /Before yielding with runnable work remaining/);
	});

	test(`${entry}: evidence-driven retries preserve unknown outcomes and completion requirements`, () => {
		assert.match(prompt, /distinguish confirmed failure, still-running work, and unknown outcome/);
		assert.match(prompt, /new evidence or a specific testable hypothesis, within existing tool retry limits/);
		assert.match(prompt, /Do not mechanically repeat unchanged attempts or switch tools to bypass permissions or safety boundaries/);
		assert.match(prompt, /external write with an unknown outcome, use read-only checks of the same target/);
		assert.match(prompt, /never replay it merely because it timed out or lacked success evidence/);
		assert.match(prompt, /outcome remains unknown, report that uncertainty and pause rather than replay/);
		assert.match(prompt, /three-turn minimum gates goal_blocked only; it is not required work/);
		assert.match(prompt, /no meaningful new investigation or justified retry remains.*end without goal_continue so Goal pauses immediately/);
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
		assert.match(prompt, /no new admissible evidence or justified repair is available.*end without goal_continue so Goal pauses/);
		assert.doesNotMatch(prompt, /gather stronger evidence and keep working\./);
	});
}
