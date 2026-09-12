export function createOperationGuard(state, expectedEpoch) {
	const revision = state.operationRevision;
	return {
		revision,
		assert() {
			if (state.operationRevision !== revision || state.epoch !== expectedEpoch || state.generation === undefined) throw new Error("browser relay operation invalidated");
		},
		invalidate() {
			if (state.operationRevision === revision) state.operationRevision += 1;
		},
	};
}
