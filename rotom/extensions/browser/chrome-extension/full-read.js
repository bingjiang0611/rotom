export function scrollableTextTargets(rootDocument = document, maxTargets = 3) {
	const candidates = [];
	const seenElements = new Set();
	const seenDocuments = new Set();
	const documents = [rootDocument];
	const elements = [];
	for (let documentIndex = 0; documentIndex < documents.length && documentIndex < 8; documentIndex += 1) {
		const currentDocument = documents[documentIndex];
		if (!currentDocument || seenDocuments.has(currentDocument)) continue;
		seenDocuments.add(currentDocument);
		const root = currentDocument.scrollingElement;
		if (root) elements.push(root);
		const view = currentDocument.defaultView;
		const width = Math.max(1, Number(view?.innerWidth) || Number(root?.clientWidth) || 1);
		const height = Math.max(1, Number(view?.innerHeight) || Number(root?.clientHeight) || 1);
		for (const [xRatio, yRatio] of [[0.2, 0.25], [0.35, 0.25], [0.5, 0.25], [0.65, 0.25], [0.8, 0.25], [0.92, 0.25], [0.2, 0.5], [0.35, 0.5], [0.5, 0.5], [0.65, 0.5], [0.8, 0.5], [0.92, 0.5], [0.2, 0.75], [0.35, 0.75], [0.5, 0.75], [0.65, 0.75], [0.8, 0.75], [0.92, 0.75]]) {
			let hits = [];
			try { hits = currentDocument.elementsFromPoint(width * xRatio, height * yRatio); } catch {}
			for (const hit of hits) {
				for (let element = hit; element;) {
					elements.push(element);
					if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
						try { if (element.contentDocument) documents.push(element.contentDocument); } catch {}
					}
					const parent = element.parentElement;
					if (parent) element = parent;
					else {
						let host;
						try { host = element.getRootNode?.()?.host; } catch {}
						element = host;
					}
				}
			}
		}
		let frames = [];
		try { frames = currentDocument.querySelectorAll("iframe,frame"); } catch {}
		for (const frame of frames) try { if (frame.contentDocument) documents.push(frame.contentDocument); } catch {}
	}
	for (const element of elements) {
		if (!element || seenElements.has(element)) continue;
		seenElements.add(element);
		const ownerDocument = element.ownerDocument;
		const root = ownerDocument?.scrollingElement;
		const clientHeight = Number(element.clientHeight) || 0;
		const clientWidth = Number(element.clientWidth) || 0;
		const scrollHeight = Number(element.scrollHeight) || 0;
		const range = Math.max(0, scrollHeight - clientHeight);
		if (element !== root && (clientHeight < 120 || clientWidth < 160 || range < 8)) continue;
		let rect;
		try { rect = element.getBoundingClientRect(); } catch { continue; }
		if (element !== root && (!rect || rect.width < 160 || rect.height < 120 || rect.bottom <= 0 || rect.right <= 0)) continue;
		if (element !== root) {
			let overflowY = "";
			try { overflowY = ownerDocument?.defaultView?.getComputedStyle(element)?.overflowY ?? ""; } catch {}
			if (!/(?:auto|scroll|overlay)/u.test(overflowY)) continue;
		}
		const textLength = typeof element.innerText === "string" ? element.innerText.trim().length : 0;
		const area = Math.max(1, Math.min(clientWidth, 2_000) * Math.min(clientHeight, 2_000));
		const score = Math.max(1, range) * Math.log2(textLength + 2) * Math.sqrt(area);
		candidates.push({ element, score, range, textLength });
	}
	candidates.sort((left, right) => right.score - left.score || right.range - left.range || right.textLength - left.textLength);
	return candidates.slice(0, Math.max(1, Math.min(Number(maxTargets) || 1, 8))).map((candidate) => candidate.element);
}

export function scrollTargetState() {
	const ownerDocument = this?.ownerDocument;
	const isRoot = ownerDocument?.scrollingElement === this;
	const textSource = isRoot ? ownerDocument?.body : this;
	return {
		top: Number(this?.scrollTop) || 0,
		clientHeight: Number(this?.clientHeight) || 0,
		scrollHeight: Number(this?.scrollHeight) || 0,
		text: typeof textSource?.innerText === "string" ? textSource.innerText.trim() : "",
	};
}

export function scrollTargetTo(top) {
	if (!this) return 0;
	this.scrollTop = Math.max(0, Number(top) || 0);
	return Number(this.scrollTop) || 0;
}

export function mergeRenderedText(existing, sample, maxCharacters = 500_000) {
	const lines = (value) => String(value ?? "").replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
	const current = lines(existing);
	const incoming = lines(sample);
	if (incoming.length === 0) return { text: current.join("\n"), truncated: false, addedLines: 0 };

	let contained = false;
	if (incoming.length <= current.length) {
		outer: for (let start = 0; start <= current.length - incoming.length; start += 1) {
			for (let index = 0; index < incoming.length; index += 1) if (current[start + index] !== incoming[index]) continue outer;
			contained = true;
			break;
		}
	}
	let added = contained ? [] : incoming;
	if (!contained && current.length > 0) {
		for (let overlap = Math.min(current.length, incoming.length); overlap > 0; overlap -= 1) {
			let matches = true;
			for (let index = 0; index < overlap; index += 1) {
				if (current[current.length - overlap + index] !== incoming[index]) { matches = false; break; }
			}
			if (matches) { added = incoming.slice(overlap); break; }
		}
	}
	const combined = [...current, ...added];
	let text = combined.join("\n");
	let truncated = false;
	if (text.length > maxCharacters) { text = text.slice(0, maxCharacters); truncated = true; }
	return { text, truncated, addedLines: added.length };
}
