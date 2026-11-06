function revisionOf(state, scopeKey) {
	return state.operationRevisions.get(scopeKey) ?? 0;
}

/**
 * A revision per lock scope, not per session: two tabs may run operations at the
 * same time, so one finishing must not invalidate the other. Session-wide epoch
 * and generation checks still retire everything when the binding changes.
 */
export function createOperationGuard(state, expectedEpoch, scopeKey = "session") {
	const revision = revisionOf(state, scopeKey);
	return {
		revision,
		assert() {
			if (revisionOf(state, scopeKey) !== revision || state.epoch !== expectedEpoch || state.generation === undefined) throw new Error("browser relay operation invalidated");
		},
		invalidate() {
			if (revisionOf(state, scopeKey) === revision) state.operationRevisions.set(scopeKey, revision + 1);
		},
	};
}
