function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

export function coordinateViewport(metrics) {
	const viewport = metrics?.cssVisualViewport ?? metrics?.visualViewport;
	const width = Number(viewport?.clientWidth);
	const height = Number(viewport?.clientHeight);
	const pageX = Number(viewport?.pageX ?? 0);
	const pageY = Number(viewport?.pageY ?? 0);
	const scale = Number(viewport?.scale ?? 1);
	if (![width, height, pageX, pageY, scale].every(finiteNumber) || width <= 2 || height <= 2 || scale <= 0) throw new Error("coordinate screenshot viewport unavailable");
	return { width, height, pageX, pageY, scale };
}

export function invalidateCoordinateObservation(item) {
	item.observationEpoch = Number.isSafeInteger(item.observationEpoch) && item.observationEpoch >= 0 ? item.observationEpoch + 1 : 1;
	item.coordinateObservation = undefined;
	return item.observationEpoch;
}

export function mintCoordinateObservation(item, metrics) {
	const viewport = coordinateViewport(metrics);
	const observationEpoch = invalidateCoordinateObservation(item);
	item.coordinateObservation = { observationEpoch, documentGeneration: item.documentGeneration, viewport };
	return { observationEpoch, viewport };
}

export function validateCoordinateBinding(item, payload, metrics) {
	const expected = item.coordinateObservation;
	if (!expected) throw new Error("coordinate click requires a current browser screenshot");
	if (!Number.isSafeInteger(payload?.observationEpoch) || payload.observationEpoch < 1 || payload.observationEpoch !== expected.observationEpoch || payload.observationEpoch !== item.observationEpoch) throw new Error("coordinate screenshot observation epoch is stale");
	if (!Number.isSafeInteger(payload?.documentGeneration) || payload.documentGeneration !== item.documentGeneration || payload.documentGeneration !== expected.documentGeneration) throw new Error("coordinate screenshot document generation is stale");
	const current = coordinateViewport(metrics);
	for (const key of ["width", "height", "pageX", "pageY", "scale"]) if (Math.abs(current[key] - expected.viewport[key]) > 0.5) throw new Error("coordinate screenshot viewport changed; capture a new screenshot");
	const x = Number(payload.x);
	const y = Number(payload.y);
	if (!finiteNumber(x) || !finiteNumber(y) || x < 1 || y < 1 || x >= current.width - 1 || y >= current.height - 1) throw new Error("coordinate click point is outside the current screenshot viewport");
	return { x, y, viewport: current };
}

export function validateCoordinateHit(value) {
	const backendNodeId = Number(value?.backendNodeId);
	const nodeName = typeof value?.nodeName === "string" ? value.nodeName.toLowerCase() : "";
	if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 1) throw new Error("coordinate click hit-test found no DOM target");
	if (!nodeName || ["#document", "html", "body", "iframe", "frame"].includes(nodeName)) throw new Error("coordinate click hit-test target is ambiguous");
	return { backendNodeId, nodeName };
}
