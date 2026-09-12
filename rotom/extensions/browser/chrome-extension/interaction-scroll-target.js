export function interactionScrollTarget() {
	let document = this?.nodeType === 9 ? this : this?.ownerDocument;
	if (!document) return null;
	const centerHit = (candidateDocument, bounds) => {
		if (typeof candidateDocument?.elementFromPoint !== "function") return null;
		const view = candidateDocument.defaultView;
		const width = Number(bounds?.width ?? view?.innerWidth);
		const height = Number(bounds?.height ?? view?.innerHeight);
		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) return null;
		try { return candidateDocument.elementFromPoint(width / 2, height / 2); }
		catch { return null; }
	};
	const descendFrame = (candidate) => {
		let current = candidate;
		for (let depth = 0; current && depth < 8; depth += 1) {
			let frameDocument;
			try { frameDocument = current.contentDocument; } catch { frameDocument = undefined; }
			if (!frameDocument || frameDocument.nodeType !== 9) break;
			document = frameDocument;
			current = centerHit(frameDocument) ?? frameDocument.body ?? frameDocument.documentElement;
		}
		return current;
	};
	let current;
	if (this?.nodeType === 9) {
		current = descendFrame(centerHit(document));
	} else {
		let hit;
		try {
			const bounds = this?.getBoundingClientRect?.();
			if (bounds && Number(bounds.width) > 1 && Number(bounds.height) > 1 && typeof document.elementFromPoint === "function") {
				hit = document.elementFromPoint(Number(bounds.left) + Number(bounds.width) / 2, Number(bounds.top) + Number(bounds.height) / 2);
				if (hit && typeof this.contains === "function" && !this.contains(hit)) hit = undefined;
			}
		} catch { hit = undefined; }
		current = descendFrame(hit ?? this);
	}
	while (current) {
		if (current.nodeType === 1) {
			const view = current.ownerDocument?.defaultView ?? document.defaultView;
			const overflowY = String(view?.getComputedStyle?.(current)?.overflowY ?? "").toLowerCase();
			if (["auto", "scroll", "overlay"].includes(overflowY) && Number(current.scrollHeight) > Number(current.clientHeight) + 1) return current;
		}
		if (current.parentElement) {
			current = current.parentElement;
			continue;
		}
		const root = typeof current.getRootNode === "function" ? current.getRootNode() : undefined;
		const host = root?.host;
		if (!host || host === current) break;
		current = host;
	}
	return document.scrollingElement ?? document.documentElement ?? null;
}
