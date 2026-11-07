export const helperMismatchMessage = (
	expectedProtocol: number,
	expectedExecutable: string,
	actualProtocol: number,
	actualExecutable: string | undefined,
): string => `pi-computer-use helper mismatch: expected protocol ${expectedProtocol} and executable ${expectedExecutable}; got protocol ${actualProtocol} and executable ${actualExecutable ?? "unknown"}. The running helper was not restarted. Close its owning sessions and explicitly install/restart the updated helper, or use a separate helper app and socket. ${helperUnavailableGuidance}`;

/** Model-facing next step: the mismatch does not change until a person acts. */
export const helperUnavailableGuidance =
	"Computer Use is unavailable in this session until a person restarts the helper. Do not call Computer Use tools again for this; use the browser tools for web pages, or report the blocker to the user.";

/** Asked once per session before stopping a helper that other sessions may own. */
export const helperRestartCopy = {
	title: "Computer Use helper is out of date",
	message: (actualProtocol: number, expectedProtocol: number): string =>
		`A Computer Use helper speaking protocol ${actualProtocol} is still running; this rotom needs protocol ${expectedProtocol}. Restarting it stops the old helper, and any other rotom session using Computer Use loses it until that session reconnects. Restart it now? If you decline, Computer Use stays unavailable in this session.`,
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
