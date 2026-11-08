/**
 * Goal schemas stay visible from startup, but Goal mode is not active: every call must be
 * rejected without persisting a transition or changing the tool policy. Split out of
 * smoke-runtime.mjs so each maintenance script stays inside the commit size budget.
 */
export async function assertInactiveGoalSurface({ assert, goalNames, activeNames, thirdParty, manager, agentSession, context }) {
	const activeToolNamesBefore = agentSession.getActiveToolNames();
	for (const name of goalNames) {
		assert.ok(activeNames.includes(name), `${name} schema must remain active without a Goal`);
		const definition = thirdParty.tools.get(name).definition;
		assert.match(definition.description, /Tool visibility alone does not activate Goal mode/u);
		const branchBefore = JSON.stringify(manager.getBranch());
		const params = {
			goal_complete: { goal_id: "inactive-smoke-goal", summary: "Fixture completion evidence" },
			goal_blocked: { goal_id: "inactive-smoke-goal", reason: "Fixture blocker", evidence: "Fixture evidence", repeated_turns: 3 },
			goal_wait: { goal_id: "inactive-smoke-goal", reason: "Fixture external wait" },
			goal_continue: { goal_id: "inactive-smoke-goal", next_action: "Fixture next action" },
		}[name];
		const rejected = await definition.execute(`inactive-${name}`, params, undefined, undefined, context);
		assert.match(rejected.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), /rejected: no active goal/u);
		assert.notEqual(rejected.terminate, true, "inactive Goal tools must not terminate ordinary work");
		assert.equal(JSON.stringify(manager.getBranch()), branchBefore, "inactive calls must not persist Goal transitions");
		assert.deepEqual(agentSession.getActiveToolNames(), activeToolNamesBefore, "inactive calls must not change the tool policy");
	}
}
