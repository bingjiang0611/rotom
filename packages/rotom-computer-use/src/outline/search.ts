import { outlineNodeLabel, outlineNodePath } from "./lookup.ts";
import type { Outline, OutlineNode, OutlineSearchMatch } from "./types.ts";

/**
 * Finding nodes by text, role or capability.
 *
 * Two entry points: the ranked search used by tools (exact/prefix/substring/fuzzy) and
 * the plain filter used by callers that want every match in tree order.
 */
function actionMatches(node: OutlineNode, action: string): boolean {
	const query = action.toLowerCase();
	if (query === "press" && node.canPress) return true;
	if (query === "focus" && node.canFocus) return true;
	if ((query === "setvalue" || query === "set_text" || query === "settext") && node.canSetValue) return true;
	if (query === "scroll" && node.canScroll) return true;
	if (query === "increment" && node.canIncrement) return true;
	if (query === "decrement" && node.canDecrement) return true;
	return node.actions.some((candidate) => candidate.toLowerCase().includes(query));
}

function normalizedSearchRole(value: string): string {
	return value.trim().toLowerCase().replace(/^ax/, "").replace(/[ _-]+/g, "");
}

function damerauLevenshtein(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const matrix = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < cols; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
		}
	}
	return matrix[a.length][b.length];
}

export function rankedTextMatch(values: string[], text: string): { reason: "exact" | "prefix" | "substring" | "fuzzy"; score: number } | undefined {
	const query = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 256);
	if (!query) return undefined;
	const candidates = values.map((value) => value.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 512)).filter(Boolean);
	if (candidates.some((value) => value === query)) return { reason: "exact", score: 1 };
	if (candidates.some((value) => value.startsWith(query) || value.split(/\W+/).some((token) => token.startsWith(query)))) return { reason: "prefix", score: 0.95 };
	if (candidates.some((value) => value.includes(query))) return { reason: "substring", score: 0.9 };
	let score = 0;
	for (const value of candidates) {
		for (const candidate of [value, ...value.split(/\W+/)]) {
			if (!candidate || candidate.length > 256) continue;
			score = Math.max(score, 1 - damerauLevenshtein(query, candidate) / Math.max(query.length, candidate.length));
		}
	}
	return score >= 0.72 ? { reason: "fuzzy", score } : undefined;
}

export function searchOutlineRanked(outline: Outline, text?: string, role?: string, capability?: string, limit = 12): { matches: OutlineSearchMatch[]; totalMatches: number } {
	const query = text?.trim();
	const roleQuery = role ? normalizedSearchRole(role) : undefined;
	const actionQuery = capability?.trim();
	const strong: Array<OutlineSearchMatch & { order: number }> = [];
	const fuzzy: Array<OutlineSearchMatch & { order: number }> = [];
	for (const [order, node] of outline.nodes.entries()) {
		if (roleQuery && normalizedSearchRole(node.role) !== roleQuery) continue;
		if (actionQuery && !actionMatches(node, actionQuery)) continue;
		const label = outlineNodeLabel(node);
		const match = query ? rankedTextMatch([label, node.identifier, node.title, node.description, node.value, ...node.text.map((item) => item.string)], query) : undefined;
		if (query && !match) continue;
		const result = { ref: node.ref, role: node.role, label, actions: node.actions, path: outlineNodePath(node), matchReason: match?.reason ?? "filter" as const, score: match?.score ?? 1, node, order };
		(match?.reason === "fuzzy" ? fuzzy : strong).push(result);
	}
	const rank = { exact: 0, prefix: 1, substring: 2, filter: 3, fuzzy: 4 } as const;
	const sorted = [...strong.sort((a, b) => rank[a.matchReason!] - rank[b.matchReason!] || b.score! - a.score! || a.order - b.order)];
	const useFuzzy = sorted.length < limit;
	if (useFuzzy) sorted.push(...fuzzy.sort((a, b) => b.score! - a.score! || a.order - b.order));
	return { matches: sorted.slice(0, limit).map(({ order: _order, ...match }) => match), totalMatches: strong.length + (useFuzzy ? fuzzy.length : 0) };
}

export function searchOutline(outline: Outline, text?: string, role?: string, action?: string, limit = 50): OutlineSearchMatch[] {
	const query = text?.trim().toLowerCase();
	const roleQuery = role?.trim();
	const actionQuery = action?.trim();
	const matches: OutlineSearchMatch[] = [];
	for (const node of outline.nodes) {
		const label = outlineNodeLabel(node);
		// outlineNodeLabel short-circuits (title || description || value), so
		// list the fields individually too or a titled node's value/description
		// can never match.
		const haystack = [label, node.role, node.subrole, node.identifier, node.title, node.description, node.value, ...node.text.map((item) => item.string)].join(" ").toLowerCase();
		if (query && !haystack.includes(query)) continue;
		if (roleQuery && node.role !== roleQuery) continue;
		if (actionQuery && !actionMatches(node, actionQuery)) continue;
		matches.push({ ref: node.ref, role: node.role, label, actions: node.actions, path: outlineNodePath(node), node });
		if (matches.length >= limit) break;
	}
	return matches;
}
