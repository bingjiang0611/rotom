// Dispatch vs. page dialog.
//
// A JavaScript dialog suspends the renderer, so `mouseReleased` (and anything else that
// waits on the page) does not resolve while one is open. The dispatch therefore has to be
// watched for a dialog — but the watch must never stand in for dispatch completion:
// answering "settled" because no dialog appeared would return before the action finished,
// release the tab lock under a live dispatch and report an effect the action never
// produced. So the answer is either the dialog, or the dispatch's own result, or an
// explicit timeout that callers report as unknown.

export const DIALOG_DETECT_POLL_MS = 25;

/**
 * @param {{
 *   dispatch: () => Promise<unknown>,
 *   dialog: () => unknown,
 *   deadlineMs: number,
 *   pollMs?: number,
 *   now?: () => number,
 * }} input
 *   `dispatch` runs the action, `dialog` returns the tab's pending dialog or undefined,
 *   `deadlineMs` bounds the wait so a hung dispatch cannot poll forever.
 * @returns {Promise<{ dialog?: unknown, settled?: true, timedOut?: true }>} the dialog if one
 *   opened while the dispatch was still running; `{ settled: true }` only after the dispatch
 *   finished; `{ timedOut: true }` when it did not finish inside the deadline. A dispatch
 *   error is rethrown; a dispatch still running when a dialog or the deadline wins keeps
 *   running and its rejection is swallowed here, never left unhandled.
 */
export async function raceDispatchAgainstDialog(input) {
	const pollMs = input.pollMs ?? DIALOG_DETECT_POLL_MS;
	const now = input.now ?? Date.now;
	const deadlineAt = now() + input.deadlineMs;
	let watching = true;
	let failure;
	const dispatch = input.dispatch().catch((error) => { failure = error; });
	const watch = (async () => {
		while (watching) {
			const dialog = input.dialog();
			if (dialog !== undefined) return { dialog };
			if (now() >= deadlineAt) return { timedOut: true };
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		return {};
	})();
	const raced = await Promise.race([dispatch.then(() => ({ settled: true })), watch]);
	watching = false;
	if (raced.dialog !== undefined) return raced;
	if (raced.timedOut !== undefined) return raced;
	if (failure !== undefined) throw failure;
	return { settled: true };
}
