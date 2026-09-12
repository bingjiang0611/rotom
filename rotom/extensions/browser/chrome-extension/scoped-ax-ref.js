export function formatScopedAxRef(generation, scopeId, backendNodeId) {
	if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(backendNodeId) || backendNodeId < 1) throw new Error("AX ref identity invalid");
	if (scopeId === "r") return `ax_${generation}_${backendNodeId}`;
	if (!/^f[1-9]\d*$/.test(scopeId)) throw new Error("AX ref scope invalid");
	return `ax_${generation}_${scopeId}_${backendNodeId}`;
}

export function parseScopedAxRef(ref, generation) {
	const match = /^ax_(\d+)_(?:(r|f[1-9]\d*)_)?([1-9]\d*)$/.exec(ref);
	if (!match || Number(match[1]) !== generation) return undefined;
	const backendNodeId = Number(match[3]);
	if (!Number.isSafeInteger(backendNodeId)) return undefined;
	return { ref, backendNodeId, scopeId: match[2] ?? "r" };
}
