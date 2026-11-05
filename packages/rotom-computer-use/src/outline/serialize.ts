import { nodeByRef } from "./lookup.ts";
import type { Outline, OutlineNode, OutlineSearchMatch, SerializedOutline, SerializedOutlineNode, SerializedOutlineSearchMatch } from "./types.ts";

/**
 * Persisting an outline and grafting a scoped look into it.
 *
 * A session stores outlines without parent links, so a restored outline is rebuilt
 * rather than trusted. Grafting replaces a subtree with a fresher scoped look while
 * keeping the nodes the scoped look never saw.
 */
export function serializeOutlineSearchMatch(match: OutlineSearchMatch): SerializedOutlineSearchMatch {
	const { node: _node, ...serialized } = match;
	return serialized;
}

export function countOutlineNodes(root: OutlineNode): number {
	let count = 1;
	for (const child of root.children) count += countOutlineNodes(child);
	return count;
}

export function serializeOutline(outline: Outline): SerializedOutline {
	return { lookId: outline.lookId, root: serializeOutlineNode(outline.root) };
}

export function serializeOutlineNode(node: OutlineNode): SerializedOutlineNode {
	const { parent: _parent, children, ...rest } = node;
	return { ...rest, children: children.map(serializeOutlineNode) };
}

export function serializeOutlineNodeShallow(node: OutlineNode): SerializedOutlineNode {
	const { parent: _parent, children: _children, ...rest } = node;
	return { ...rest, children: [] };
}

export function restoreOutline(serialized: SerializedOutline): Outline {
	const nodes: OutlineNode[] = [];
	const refToWireRef = new Map<string, string>();
	const wireRefToRef = new Map<string, string>();
	const restoreNode = (raw: SerializedOutlineNode, parent?: OutlineNode): OutlineNode => {
		// A session stored before the marker existed has no `secure` field; default it
		// rather than carry `undefined` into a boolean.
		const node: OutlineNode = { ...raw, secure: raw.secure === true, children: [], parent };
		nodes.push(node);
		if (node.wireRef) {
			refToWireRef.set(node.ref, node.wireRef);
			wireRefToRef.set(node.wireRef, node.ref);
		}
		node.children = raw.children.map((child) => restoreNode(child, node));
		return node;
	};
	const root = restoreNode(serialized.root);
	return { lookId: serialized.lookId, root, nodes, refToWireRef, wireRefToRef };
}

function outlineRefNumber(ref: string): number {
	const match = /^@e(\d+)$/.exec(ref);
	return match ? Number(match[1]) : 0;
}

function clearScopedRects(node: OutlineNode): void {
	// Scoped look geometry is in the scoped image's pixel space, not the full look.
	// Until helper-side act carries stable look geometry, grafted nodes are AX-only
	// for ref actions; coordinate fallback must re-observe the full window.
	node.rect = undefined;
	for (const text of node.text) text.rect = undefined;
	for (const child of node.children) clearScopedRects(child);
}

function rebuildIndexes(outline: Outline): void {
	outline.nodes = [];
	outline.refToWireRef = new Map();
	outline.wireRefToRef = new Map();
	const queue = [outline.root];
	let index = 0;
	while (index < queue.length) {
		const node = queue[index++];
		outline.nodes.push(node);
		if (node.wireRef) {
			outline.refToWireRef.set(node.ref, node.wireRef);
			outline.wireRefToRef.set(node.wireRef, node.ref);
		}
		queue.push(...node.children);
	}
}

function copyNodeFields(target: OutlineNode, source: OutlineNode, preserveWireRef = false): void {
	if (!preserveWireRef) target.wireRef = source.wireRef;
	target.role = source.role;
	target.subrole = source.subrole;
	target.identifier = source.identifier;
	target.title = source.title;
	target.description = source.description;
	target.value = source.value;
	target.actions = [...source.actions];
	target.canPress = source.canPress;
	target.canFocus = source.canFocus;
	target.canSetValue = source.canSetValue;
	target.canScroll = source.canScroll;
	target.canIncrement = source.canIncrement;
	target.canDecrement = source.canDecrement;
	target.isTextInput = source.isTextInput;
	target.secure = source.secure;
	target.rect = source.rect;
	target.focused = source.focused;
	target.offscreen = source.offscreen;
	target.pictureOnly = source.pictureOnly;
	target.truncated = false;
	target.scrollExtent = source.scrollExtent ? { ...source.scrollExtent } : undefined;
	target.text = source.text.map((text) => ({ ...text, rect: text.rect ? { ...text.rect } : undefined }));
}

function preserveUnreused(node: OutlineNode, parent: OutlineNode, used: Set<OutlineNode>): OutlineNode | undefined {
	if (used.has(node)) return undefined;
	node.parent = parent;
	node.children = node.children
		.map((child) => preserveUnreused(child, node, used))
		.filter((child): child is OutlineNode => Boolean(child));
	return node;
}

function cloneForGraft(source: OutlineNode, parent: OutlineNode, nextRef: () => string, reusableByWireRef: Map<string, OutlineNode>, used: Set<OutlineNode>): OutlineNode {
	const existing = source.wireRef ? reusableByWireRef.get(source.wireRef) : undefined;
	if (existing) used.add(existing);
	const oldChildren = existing?.children ?? [];
	const node: OutlineNode = existing ?? {
		...source,
		ref: nextRef(),
		children: [],
		parent,
		text: [],
		actions: [],
		scrollExtent: undefined,
	};
	copyNodeFields(node, source, Boolean(existing));
	node.parent = parent;
	const graftedChildren = source.children.map((child) => cloneForGraft(child, node, nextRef, reusableByWireRef, used));
	const preservedChildren = oldChildren
		.map((child) => preserveUnreused(child, node, used))
		.filter((child): child is OutlineNode => Boolean(child));
	node.children = [...graftedChildren, ...preservedChildren];
	return node;
}

export function graftScopedOutline(outline: Outline, targetRef: string, scoped: Outline): OutlineNode {
	const target = nodeByRef(outline, targetRef);
	if (!target) throw new Error(`Cannot graft scoped outline: target ${targetRef} is not in the current outline.`);
	const targetRect = target.rect ? { ...target.rect } : undefined;
	const reusableByWireRef = new Map<string, OutlineNode>();
	const collect = (node: OutlineNode) => {
		if (node.wireRef) reusableByWireRef.set(node.wireRef, node);
		for (const child of node.children) collect(child);
	};
	collect(target);
	let nextNumber = Math.max(...outline.nodes.map((node) => outlineRefNumber(node.ref)), 0) + 1;
	const nextRef = () => `@e${nextNumber++}`;
	const oldChildren = target.children;
	const used = new Set<OutlineNode>([target]);
	copyNodeFields(target, scoped.root, true);
	target.ref = targetRef;
	target.rect = targetRect;
	const graftedChildren = scoped.root.children.map((child) => cloneForGraft(child, target, nextRef, reusableByWireRef, used));
	const preservedChildren = oldChildren
		.map((child) => preserveUnreused(child, target, used))
		.filter((child): child is OutlineNode => Boolean(child));
	target.children = [...graftedChildren, ...preservedChildren];
	for (const child of target.children) clearScopedRects(child);
	rebuildIndexes(outline);
	return target;
}
