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

export async function requireQuietGlobalInput({ helper, record, seconds = GLOBAL_INPUT_QUIET_SECONDS }) {
	let activity;
	try {
		activity = await helper.command("userActivity", {});
	} catch (error) {
		record("gate", "global input quiet", "skipped", `helper userActivity failed: ${error instanceof Error ? error.message : String(error)}`);
		return { allowed: false, activity: undefined };
	}
	const decision = judgeGlobalInputQuiet(activity, seconds);
	const note = `required=${seconds}s listening=${decision.listening} listeningSeconds=${Number.isFinite(decision.listeningSeconds) ? decision.listeningSeconds : "?"} idleSeconds=${Number.isFinite(decision.idleSeconds) ? decision.idleSeconds : "?"} userEvents=${Number.isFinite(decision.userEventCount) ? decision.userEventCount : "?"}`;
	record("gate", "global input quiet", decision.allowed ? "pass" : "skipped", note);
	return { ...decision, activity };
}
