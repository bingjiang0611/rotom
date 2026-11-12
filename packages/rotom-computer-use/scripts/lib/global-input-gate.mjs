import { GLOBAL_INPUT_QUIET_SECONDS, judgeGlobalInputQuiet } from "../../src/policy/global-input-quiet.mjs";
export { GLOBAL_INPUT_QUIET_SECONDS, judgeGlobalInputQuiet };

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
