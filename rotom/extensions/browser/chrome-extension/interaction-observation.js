export function observedInteractionNode(nodes, ref) {
	const node = Array.isArray(nodes) ? nodes.find((candidate) => candidate?.ref === ref) : undefined;
	if (!node) throw new Error("interaction target ref is stale or unavailable; refresh snapshot_visible");
	return node;
}
