export function collectRenderedText(rootWindow = window) {
	const documents = new Set();
	const parts = [];
	const visit = (candidate) => {
		let document;
		try { document = candidate.document; } catch { return; }
		if (!document || documents.has(document)) return;
		documents.add(document);
		const text = typeof document.body?.innerText === "string" ? document.body.innerText.trim() : "";
		if (text) parts.push(text);
		let length = 0;
		try { length = candidate.frames.length; } catch { return; }
		for (let index = 0; index < length; index += 1) {
			try { visit(candidate.frames[index]); } catch { /* cross-origin frame is collected in its child CDP session */ }
		}
	};
	visit(rootWindow);
	return parts.join("\n\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function utf8TextChunks(value, maxBytes, maxChunks) {
	if (typeof value !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || !Number.isSafeInteger(maxChunks) || maxChunks < 1) return { chunks: [], truncated: false };
	const encoder = new TextEncoder();
	const chunks = [];
	let current = "";
	let currentBytes = 0;
	let consumed = 0;
	for (const character of value) {
		const characterBytes = encoder.encode(character).length;
		if (current && currentBytes + characterBytes > maxBytes) {
			chunks.push(current);
			if (chunks.length >= maxChunks) return { chunks, truncated: true };
			current = "";
			currentBytes = 0;
		}
		current += character;
		currentBytes += characterBytes;
		consumed += character.length;
	}
	if (current) chunks.push(current);
	return { chunks, truncated: consumed < value.length };
}
