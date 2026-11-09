export const GLOBAL_INPUT_QUIET_SECONDS = 30;

/**
 * Fail closed before a global keyboard or mouse action.
 *
 * The helper must have continuously observed the session for the full window,
 * and it must report no unmarked input during that window. Agent-marked input
 * does not affect this gate.
 */
export function judgeGlobalInputQuiet(activity, seconds = GLOBAL_INPUT_QUIET_SECONDS) {
	const listening = activity?.listening === true;
	const listeningSeconds = Number(activity?.listeningSeconds);
	const lastUserInputAt = Number(activity?.lastUserInputAt);
	const idleSeconds = Number(activity?.idleSeconds);
	const observedFullWindow = listening && Number.isFinite(listeningSeconds) && listeningSeconds >= seconds;
	const noRecentUserInput = lastUserInputAt === 0
		? observedFullWindow
		: Number.isFinite(lastUserInputAt) && lastUserInputAt > 0 && Number.isFinite(idleSeconds) && idleSeconds >= seconds;
	return {
		allowed: observedFullWindow && noRecentUserInput,
		listening,
		listeningSeconds,
		idleSeconds,
		lastUserInputAt,
		userEventCount: Number(activity?.userEventCount),
	};
}
