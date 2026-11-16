export const helperMismatchMessage = (
	expectedProtocol: number,
	expectedExecutable: string,
	actualProtocol: number,
	actualExecutable: string | undefined,
): string => `pi-computer-use helper mismatch: expected protocol ${expectedProtocol} and executable ${expectedExecutable}; got protocol ${actualProtocol} and executable ${actualExecutable ?? "unknown"}. The running helper was not restarted. On managed Macs, set PI_COMPUTER_USE_CODESIGN_IDENTITY to an existing approved signing identity before updating. It installs to ~/Applications/pi-computer-use.app without starting it; use that path in the new session, or explicitly maintain your separate helper app and socket. ${helperUnavailableGuidance}`;

/** Model-facing next step: the mismatch does not change until a person acts. */
export const helperUnavailableGuidance =
	"Computer Use is unavailable in this session. 运行 rotom helper update（它会询问是否停止旧 helper），完成后新开 rotom 会话。 Do not call Computer Use tools again for this; use the browser tools for web pages, or report the blocker to the user.";

export const takeoverCopy = {
	unsupportedHelper: "The helper does not support safe pause/resume. Use a separately built helper; the running helper was not changed.",
	started(app: string, pid: number, expiresAt: string): string {
		return `Foreground taken for ${app} (pid ${pid}) until ${expiresAt}. Real input pauses the takeover; it resumes after 30 quiet seconds if policy and the original window remain valid. Esc or the stop menu ends it permanently.`;
	},
};

export const brokerCopy = {
	blocked(tool: string, message: string, code: string, holder?: { agentId: string; remainingMs: number }): string {
		const held = code === "resource_busy" && holder
			? ` Held by agent ${holder.agentId} (${Math.ceil(holder.remainingMs / 1000)}s remaining).` : "";
		const next = code === "broker_unavailable"
			? " Broker availability or approval completion is unconfirmed; this does not prove another agent holds the app. Stop and inspect broker/approval diagnostics; do not automatically retry, stop another session or disable arbitration."
			: code === "resource_busy"
				? " Wait for the holder to release the app, then obtain a fresh observation before a new action."
				: " Resolve the refusal before requesting a new action.";
		return `${tool} was blocked before native input: ${message}${held}${next}`;
	},
	notDispatched: "act_ui evidence: dispatch=not_started; verification=not_reported. The lease failed before native input; this does not verify the current application state.",
};
