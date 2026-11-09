export const helperMismatchMessage = (
	expectedProtocol: number,
	expectedExecutable: string,
	actualProtocol: number,
	actualExecutable: string | undefined,
): string => `pi-computer-use helper mismatch: expected protocol ${expectedProtocol} and executable ${expectedExecutable}; got protocol ${actualProtocol} and executable ${actualExecutable ?? "unknown"}. The running helper was not restarted. Close its owning sessions and explicitly install/restart the updated helper, or use a separate helper app and socket.`;

export const takeoverCopy = {
	unsupportedHelper: "The helper does not support safe pause/resume. Use a separately built helper; the running helper was not changed.",
	started(app: string, pid: number, expiresAt: string): string {
		return `Foreground taken for ${app} (pid ${pid}) until ${expiresAt}. Real input pauses the takeover; it resumes after 30 quiet seconds if authorization and the original window remain valid. Esc or the stop menu ends it permanently.`;
	},
};

/** Three-way app authorization card shown to the human, never to the model. */
export const approvalCopy = {
	allowSession: "Allow for this session",
	allowAlways: "Always allow this app",
	deny: "Deny",
	options(): [string, string, string] {
		return [approvalCopy.allowSession, approvalCopy.allowAlways, approvalCopy.deny];
	},
	title(input: { app: string; tier: string; action: string; label?: string; sensitive?: string; warning?: string }): string {
		const lines = [`Computer Use: allow an agent to control ${input.app}? (tier: ${input.tier})`];
		lines.push(input.action);
		if (input.label) lines.push(`Target: ${JSON.stringify(input.label)}`);
		if (input.sensitive) lines.push(input.sensitive);
		if (input.warning) lines.push(input.warning);
		return lines.join("\n");
	},
};
