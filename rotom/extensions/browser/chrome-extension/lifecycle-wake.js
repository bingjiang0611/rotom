// Keep an agent tab from being frozen or discarded while it is being driven.
//
// Every operation that attaches to a tab also asks Chrome to move it back to the
// active lifecycle state. The call is best-effort: an older Chrome, a detached
// debugger or a tab that is already active must not fail the operation, so a
// failure is only reported as a diagnostic.

export async function withTabWake({ item, sendCommand, assertOperation = () => undefined, diagnose = () => undefined }) {
	if (!Number.isInteger(item?.tabId)) return { woken: false };
	try {
		assertOperation();
		await sendCommand({ tabId: item.tabId }, "Page.setWebLifecycleState", { state: "active" });
		return { woken: true };
	} catch (error) {
		diagnose(error instanceof Error ? error.message.slice(0, 200) : "unknown lifecycle wake failure");
		return { woken: false };
	}
}
