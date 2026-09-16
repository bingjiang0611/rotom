// Keep only the already-bounded rendered text, not another AX tree or page history.
export function observationTextBaseline(observation) {
	return {
		documentGeneration: observation.documentGeneration,
		observationEpoch: observation.observationEpoch,
		nodes: observation.nodes.filter((node) => node.role === "document-text"),
	};
}

export function compactInteractionReadback(observation, baseline) {
	if (!baseline || baseline.documentGeneration !== observation.documentGeneration || baseline.observationEpoch >= observation.observationEpoch) return observation;
	const previous = new Map(baseline.nodes.map((node) => [node.ref, node.name]));
	const nodes = observation.nodes.filter((node) => node.role !== "document-text" || previous.get(node.ref) !== node.name);
	const omittedUnchangedTextNodes = observation.nodes.length - nodes.length;
	if (!omittedUnchangedTextNodes) return observation;
	return {
		...observation,
		nodes,
		omittedUnchangedTextNodes,
		textBaselineEpoch: baseline.observationEpoch,
		// A delta is never a complete document, even when every chunk matched.
		contentComplete: false,
	};
}

export function observedInteractionNode(nodes, ref) {
	const node = Array.isArray(nodes) ? nodes.find((candidate) => candidate?.ref === ref) : undefined;
	if (!node) throw new Error("interaction target ref is stale or unavailable; refresh snapshot_visible");
	return node;
}
