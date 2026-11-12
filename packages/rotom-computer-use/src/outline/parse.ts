import type { LookResponse, Outline, OutlineNode, OutlineRect, OutlineText } from "./types.ts";

/**
 * Turning a raw helper payload into the outline model.
 *
 * The helper's JSON is untrusted input: every field is coerced, and a node without a
 * reference simply has none. Nothing here decides anything; the result is data.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function toNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function toBoolean(value: unknown): boolean {
	return value === true;
}

function parseRect(raw: unknown): OutlineRect {
	const rect = isRecord(raw) ? raw : {};
	return {
		x: toNumber(rect.x),
		y: toNumber(rect.y),
		w: Math.max(0, toNumber(rect.w)),
		h: Math.max(0, toNumber(rect.h)),
	};
}

function parseText(raw: unknown): OutlineText[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): OutlineText | undefined => {
			if (!isRecord(item)) return undefined;
			const string = toString(item.string);
			if (!string) return undefined;
			return {
				string,
				confidence: Math.max(0, Math.min(1, toNumber(item.confidence))),
				rect: parseRect(item.rect),
			};
		})
		.filter((item): item is OutlineText => Boolean(item));
}

function parseNode(raw: unknown, parent?: OutlineNode): OutlineNode {
	const record = isRecord(raw) ? raw : {};
	const wireRef = toString(record.ref) || undefined;
	const node: OutlineNode = {
		ref: "",
		wireRef,
		role: toString(record.role),
		subrole: toString(record.subrole),
		identifier: toString(record.identifier),
		title: toString(record.title),
		description: toString(record.description),
		value: toString(record.value),
		actions: Array.isArray(record.actions) ? record.actions.filter((value): value is string => typeof value === "string") : [],
		canPress: toBoolean(record.canPress),
		canFocus: toBoolean(record.canFocus),
		canSetValue: toBoolean(record.canSetValue),
		canScroll: toBoolean(record.canScroll),
		canIncrement: toBoolean(record.canIncrement),
		canDecrement: toBoolean(record.canDecrement),
		isTextInput: toBoolean(record.isTextInput),
		secure: toBoolean(record.secure),
		rect: parseRect(record.rect),
		focused: toBoolean(record.focused),
		offscreen: toBoolean(record.offscreen),
		pictureOnly: toBoolean(record.pictureOnly),
		truncated: toBoolean(record.truncated),
		scrollExtent: isRecord(record.scrollExtent)
			? { seen: Math.max(0, Math.trunc(toNumber(record.scrollExtent.seen))), total: Math.max(0, Math.trunc(toNumber(record.scrollExtent.total))) }
			: undefined,
		text: parseText(record.text),
		children: [],
		parent,
	};
	node.children = (Array.isArray(record.children) ? record.children : []).map((child) => parseNode(child, node));
	return node;
}

export function parseLookResponse(raw: unknown): LookResponse {
	const record = isRecord(raw) ? raw : {};
	const image = isRecord(record.image) ? record.image : undefined;
	const window = isRecord(record.window) ? record.window : {};
	const metadata = isRecord(window.metadata) ? window.metadata : undefined;
	const outline = buildOutline(toString(record.lookId), parseNode(record.outline));
	const readText = isRecord(record.readText) ? record.readText : undefined;
	const requestedReadText = readText?.requested === "auto" || readText?.requested === "always" || readText?.requested === "never" ? readText.requested : undefined;
	const look: LookResponse = {
		lookId: toString(record.lookId),
		capturedAt: toNumber(record.capturedAt, Date.now() / 1000),
		window: {
			windowId: Math.trunc(toNumber(window.windowId)),
			rootRef: toString(window.rootRef) || undefined,
			kind: toString(window.kind) || undefined,
			framePoints: parseRect(window.framePoints),
			scaleFactor: Math.max(1, toNumber(window.scaleFactor, 1)),
			isModal: toBoolean(window.isModal),
			metadata,
			role: toString(window.role),
			subrole: toString(window.subrole),
		},
		image: image ? {
			jpegBase64: toString(image.jpegBase64),
			mimeType: image.mimeType === "image/png" ? "image/png" : "image/jpeg",
			width: Math.max(1, Math.trunc(toNumber(image.width, 1))),
			height: Math.max(1, Math.trunc(toNumber(image.height, 1))),
		} : undefined,
		outline: outline.root,
		timings: isRecord(record.timings) ? Object.fromEntries(Object.entries(record.timings).map(([key, value]) => [key, toNumber(value)])) : {},
		readText: readText ? { requested: requestedReadText, executed: toBoolean(readText.executed) } : undefined,
		parsedOutline: outline,
	};
	if (!look.lookId) throw new Error("Helper returned a look without lookId.");
	return look;
}

function buildOutline(lookId: string, root: OutlineNode): Outline {
	const nodes: OutlineNode[] = [];
	const refToWireRef = new Map<string, string>();
	const wireRefToRef = new Map<string, string>();
	const queue = [root];
	let index = 0;
	while (index < queue.length) {
		const node = queue[index++];
		node.ref = `@e${nodes.length + 1}`;
		nodes.push(node);
		if (node.wireRef) {
			refToWireRef.set(node.ref, node.wireRef);
			wireRefToRef.set(node.wireRef, node.ref);
		}
		queue.push(...node.children);
	}
	return { lookId, root, nodes, refToWireRef, wireRefToRef };
}
