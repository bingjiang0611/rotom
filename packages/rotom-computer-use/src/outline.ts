/**
 * The outline module's public surface.
 *
 * Importers keep using `./outline.ts`; the implementation lives in `./outline/*`, split
 * by responsibility: the data model, parsing a helper payload, looking a node up,
 * rendering within a budget, searching, and persisting or grafting.
 */
export * from "./outline/types.ts";
export { parseLookResponse } from "./outline/parse.ts";
export { nodeByRef, outlineHasSecureField, outlineNodeLabel, outlineNodePath } from "./outline/lookup.ts";
export { foldToBudget } from "./outline/render.ts";
export { rankedTextMatch, searchOutline, searchOutlineRanked } from "./outline/search.ts";
export {
	countOutlineNodes,
	graftScopedOutline,
	restoreOutline,
	serializeOutline,
	serializeOutlineNode,
	serializeOutlineNodeShallow,
	serializeOutlineSearchMatch,
} from "./outline/serialize.ts";
