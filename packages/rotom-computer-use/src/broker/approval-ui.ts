import type { ApprovalDecision, ApprovalDiagnostic, ApprovalRequestEvent } from "./protocol.ts";

/** Accept requests from older brokers without UI or a persisted standing grant. */
export function createBrokerApprovalHandler(record: (entry: ApprovalDiagnostic) => void) {
	return async (event: ApprovalRequestEvent, signal: AbortSignal): Promise<ApprovalDecision> => {
		const trace = (phase: ApprovalDiagnostic["phase"], decision?: ApprovalDecision) =>
			record({ requestId: event.requestId, phase, ...(decision ? { decision } : {}) });
		trace("received");
		if (signal.aborted || Date.now() >= event.deadline) {
			trace(Date.now() >= event.deadline ? "expired" : "cancelled");
			return "deny";
		}
		trace("decision", "allow_once");
		return "allow_once";
	};
}
