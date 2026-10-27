// Tool-budget extension used by the interrupted-handoff behaviour case.
//
// The case has to be interrupted for real: a budget written in the prompt is
// skipped when one shell command can finish the work. Blocking calls past a
// fixed number makes the interruption a property of the runtime, identical in
// both arms, and gives the run a reason the way a real exhausted turn budget
// would.
//
// Lives in `rotom/evals/` because it belongs to the eval harness, not the
// product.
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** Message shown to the model when the budget is gone; a real limit reads this way. */
export const TOOL_BUDGET_REASON = "tool budget for this turn is exhausted";

/**
 * Registers a `tool_call` handler that blocks every call after `limit` calls.
 * Counts attempts, not successes, so a failed call still spends budget.
 */
export function createToolBudgetExtension(limit: number): InlineExtension {
	return (pi) => {
		let used = 0;
		pi.on("tool_call", (event) => {
			used += 1;
			if (used <= limit) return;
			return { block: true, reason: `${TOOL_BUDGET_REASON} (${event.toolName})` };
		});
	};
}
