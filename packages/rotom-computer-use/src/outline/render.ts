import { nodeByRef } from "./lookup.ts";
import type { FoldResult, Outline, OutlineNode } from "./types.ts";

/**
 * Rendering an outline to text within a budget.
 *
 * Folding is a presentation decision: the tree itself is never modified, so a folded
 * node can still be searched and acted on by ref.
 */
const DEFAULT_BUDGET = { maxDepth: 2, maxNodes: 150 };

function countDescendants(node: OutlineNode): { total: number; roles: Map<string, number>; pictureOnly: number } {
	const roles = new Map<string, number>();
	let total = 0;
	let pictureOnly = 0;
	const visit = (current: OutlineNode) => {
		for (const child of current.children) {
			total += 1;
			if (child.pictureOnly) pictureOnly += 1;
			const role = child.pictureOnly ? "picture-only" : roleName(child.role);
			roles.set(role, (roles.get(role) ?? 0) + 1);
			visit(child);
		}
	};
	visit(node);
	return { total, roles, pictureOnly };
}

function roleName(role: string): string {
	const stripped = role.replace(/^AX/, "").toLowerCase();
	return stripped || "nodes";
}

function plural(count: number, singular: string): string {
	if (singular === "picture-only") return "picture-only";
	return `${singular}${count === 1 ? "" : "s"}`;
}

function foldedSummary(node: OutlineNode): string {
	const counts = countDescendants(node);
	const roleCounts = [...counts.roles.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([role, count]) => `${count} ${plural(count, role)}`);
	const countText = `${counts.total}: ${roleCounts.join(", ") || "0 children"}`;
	const scroll = node.scrollExtent ? ` [scrollable ${node.scrollExtent.seen}/${node.scrollExtent.total}]` : "";
	return ` ▸ (${countText})${scroll}`;
}

function annotationText(node: OutlineNode): string {
	const annotations = [
		node.offscreen ? "offscreen" : undefined,
		node.pictureOnly ? "pictureOnly" : undefined,
		node.truncated ? "truncated" : undefined,
		node.scrollExtent ? `scrollable ${node.scrollExtent.seen}/${node.scrollExtent.total}` : undefined,
	].filter((item): item is string => Boolean(item));
	return annotations.length ? ` [${annotations.join(", ")}]` : "";
}

function lineForNode(node: OutlineNode, depth: number, folded: boolean): string {
	const actions = node.actions.length ? ` {${node.actions.join(",")}}` : "";
	return `${"  ".repeat(depth)}${node.ref} ${displayName(node)}${actions}${annotationText(node)}${folded ? foldedSummary(node) : ""}`;
}

function pathRefs(node: OutlineNode): string[] {
	const refs: string[] = [];
	let current: OutlineNode | undefined = node;
	while (current) {
		refs.unshift(current.ref);
		current = current.parent;
	}
	return refs;
}

function defaultUnfoldRefs(outline: Outline): Set<string> {
	const refs = new Set<string>([outline.root.ref]);
	for (const node of outline.nodes) {
		if (node.truncated || node.parent?.role === "AXSheet" || node.role === "AXSheet" || node.role === "AXDialog") {
			for (const ref of pathRefs(node)) refs.add(ref);
		}
		if (node.focused) {
			for (const ref of pathRefs(node)) refs.add(ref);
			for (const child of node.children) refs.add(child.ref);
		}
	}
	return refs;
}

export function foldToBudget(outline: Outline, budget: Partial<typeof DEFAULT_BUDGET> = {}, unfoldPaths: string[] = []): FoldResult {
	const maxDepth = Math.max(0, Math.trunc(budget.maxDepth ?? DEFAULT_BUDGET.maxDepth));
	const maxNodes = Math.max(1, Math.trunc(budget.maxNodes ?? DEFAULT_BUDGET.maxNodes));
	const unfolded = defaultUnfoldRefs(outline);
	for (const ref of unfoldPaths) {
		const node = nodeByRef(outline, ref);
		if (!node) continue;
		for (const pathRef of pathRefs(node)) unfolded.add(pathRef);
		for (const child of node.children) unfolded.add(child.ref);
	}

	const lines: string[] = [];
	const renderedRefs: string[] = [];
	let truncated = false;
	const render = (node: OutlineNode, depth: number) => {
		if (lines.length >= maxNodes) {
			truncated = true;
			return;
		}
		const shouldUnfold = depth < maxDepth || unfolded.has(node.ref);
		const folded = node.children.length > 0 && !shouldUnfold;
		lines.push(lineForNode(node, depth, folded));
		renderedRefs.push(node.ref);
		if (folded) return;
		for (const child of node.children) render(child, depth + 1);
	};
	render(outline.root, 0);
	if (truncated) {
		const remaining = Math.max(0, outline.nodes.length - renderedRefs.length);
		lines.push(`… render budget reached: ${remaining} more nodes not shown; use search_ui or expand_ui(@eN)`);
	}
	return {
		text: lines.join("\n"),
		renderedRefs,
		nodeCount: outline.nodes.length,
		fullUnfoldLineCount: outline.nodes.length,
		truncated,
	};
}
