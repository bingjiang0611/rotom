import type { Outline, OutlineNode } from "./types.ts";

/**
 * Finding a node and describing where it is.
 *
 * `nodeByRef` accepts either the outline ref (`@e12`) or the helper's wire ref, which
 * is what makes a stale reference fail in one place instead of at every call site.
 */
export function nodeByRef(outline: Outline, ref: string): OutlineNode | undefined {
	return outline.nodes.find((node) => node.ref === ref || node.wireRef === ref);
}

export function outlineNodeLabel(node: OutlineNode): string {
	return node.title || node.description || node.value || node.identifier || node.text.map((item) => item.string).join(" ").trim();
}

function displayName(node: OutlineNode): string {
	const label = outlineNodeLabel(node);
	return `${node.role || "AXUnknown"}${node.subrole ? `/${node.subrole}` : ""}${label ? ` ${JSON.stringify(label)}` : ""}`;
}

export function outlineNodePath(node: OutlineNode): string {
	const parts: string[] = [];
	let current: OutlineNode | undefined = node;
	while (current) {
		parts.unshift(displayName(current));
		current = current.parent;
	}
	return parts.join(" ▸ ");
}

/**
 * True when a captured outline contains a secure text field.
 *
 * Uses the helper's native marker (protocol 9) and nothing else: the role-based guess
 * this replaced could not tell a real secure field from a node that merely named itself
 * `AXSecureTextField` (review Q3). Accepts a live or serialized outline.
 */
export function outlineHasSecureField(outline: unknown): boolean {
	const root = (outline as { root?: unknown } | undefined)?.root;
	const stack: unknown[] = root ? [root] : [];
	while (stack.length > 0) {
		const node = stack.pop() as { secure?: unknown; children?: unknown };
		if (!node || typeof node !== "object") continue;
		if (node.secure === true) return true;
		if (Array.isArray(node.children)) stack.push(...node.children);
	}
	return false;
}
