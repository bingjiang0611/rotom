export const helperMismatchMessage = (
	expectedProtocol: number,
	expectedExecutable: string,
	actualProtocol: number,
	actualExecutable: string | undefined,
): string => `pi-computer-use helper mismatch: expected protocol ${expectedProtocol} and executable ${expectedExecutable}; got protocol ${actualProtocol} and executable ${actualExecutable ?? "unknown"}. The running helper was not restarted. Close its owning sessions and explicitly install/restart the updated helper, or use a separate helper app and socket.`;
