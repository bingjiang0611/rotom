// What a disconnecting subagent leaves behind.
//
// A subagent owns tabs it opened itself, tabs it claimed from the user, and tabs
// handed to it by another agent. On disconnect:
//   * tabs it opened are closed (they were scratch work);
//   * claimed and transferred tabs are handed to the main agent of the same root
//     session, because a user tab or another agent's tab must not disappear;
//   * when the main agent is not connected, those tabs are only detached and stay
//     open for the user;
//   * `keepTabs` (lease) closes nothing: everything is detached and becomes
//     discoverable again.
// The main agent keeps the old behaviour: detach, keep ownership records.
import { uniqueTransferredNameV1 } from "./agent-transfer.js";
import { DEFAULT_AGENT_ID } from "./session-principal.js";

/**
 * Pure decision table. `tabs` is a list of `{ name, item }`, `mainTaken` the set of
 * tab names the main agent already uses (only consulted when handing back).
 */
export function sessionCleanupPlanV1({ agentId, keepTabs, hasMainAgent, tabs, mainTaken = new Set() }) {
	const plan = { closes: [], handBacks: [], detaches: [] };
	if (agentId === DEFAULT_AGENT_ID) {
		for (const { name } of tabs) plan.detaches.push({ name });
		return plan;
	}
	const taken = new Set(mainTaken);
	for (const { name, item } of tabs) {
		if (keepTabs === true) { plan.detaches.push({ name }); continue; }
		const openedHere = item.ownership !== "claimed" && item.transferredFrom === undefined;
		if (openedHere) { plan.closes.push({ name, tabId: item.tabId }); continue; }
		if (!hasMainAgent) { plan.detaches.push({ name }); continue; }
		let toName;
		try { toName = uniqueTransferredNameV1(taken, name, agentId); }
		catch { plan.detaches.push({ name }); continue; }
		taken.add(toName);
		plan.handBacks.push({ name, toName, item });
	}
	return plan;
}
