import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvalCopy } from "../constants/copy.ts";
import { requiresOpenConfirmation } from "../open-target.ts";
import { describeSensitiveMatch, matchSensitiveAction } from "../policy/sensitive.ts";
import type { ApprovalDecision, ApprovalDiagnostic, ApprovalRequestEvent } from "./protocol.ts";

/** UI-only decision, with the broker's deadline and connection lifetime. */
export function createBrokerApprovalHandler(
	ctx: Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionContext["ui"], "select"> },
	record: (entry: ApprovalDiagnostic) => void,
) {
	return async (event: ApprovalRequestEvent, signal: AbortSignal): Promise<ApprovalDecision> => {
		const trace = (phase: ApprovalDiagnostic["phase"], decision?: ApprovalDecision) =>
			record({ requestId: event.requestId, phase, ...(decision ? { decision } : {}) });
		trace("received");
		if (signal.aborted || Date.now() >= event.deadline) {
			trace(Date.now() >= event.deadline ? "expired" : "cancelled");
			return "deny";
		}
		if (!ctx.hasUI) {
			trace("unavailable");
			return "deny";
		}
		const sensitive = matchSensitiveAction(event.action);
		const oneShot = requiresOpenConfirmation(event.action);
		// This proves the UI API was called, not that a person saw the card.
		trace("prompt_requested");
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(approvalCopy.title({
				app: event.app?.appName ?? event.app?.bundleId ?? event.resourceKey,
				tier: event.tier,
				action: approvalCopy.action(event.action?.name),
				label: event.action?.label,
				sensitive: sensitive ? describeSensitiveMatch(sensitive) : undefined,
				warning: oneShot ? approvalCopy.openWarning(event.warning) : event.warning,
			}), oneShot ? [approvalCopy.allowOnce, approvalCopy.deny] : [...approvalCopy.options()], { timeout: Math.max(1, event.deadline - Date.now()), signal });
		} catch {
			trace("ui_error");
			return "deny";
		}
		if (signal.aborted || Date.now() >= event.deadline) {
			trace(Date.now() >= event.deadline ? "expired" : "cancelled");
			return "deny";
		}
		const decision = oneShot ? (choice === approvalCopy.allowOnce ? "allow_once" : "deny")
			: choice === approvalCopy.allowAlways ? "always"
			: choice === approvalCopy.allowSession ? "allow_session" : "deny";
		trace("decision", decision);
		return decision;
	};
}
