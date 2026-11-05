/**
 * The outline data model: what a look returns and what a session stores.
 */
export interface OutlineRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OutlineText {
	string: string;
	confidence: number;
	rect?: OutlineRect;
}

export interface OutlineScrollExtent {
	seen: number;
	total: number;
}

export interface OutlineNode {
	ref: string;
	wireRef?: string;
	role: string;
	subrole: string;
	identifier: string;
	title: string;
	description: string;
	value: string;
	actions: string[];
	canPress: boolean;
	canFocus: boolean;
	canSetValue: boolean;
	canScroll: boolean;
	canIncrement: boolean;
	canDecrement: boolean;
	isTextInput: boolean;
	/**
	 * The helper's native `AXSecureTextField` marker (protocol 9).
	 *
	 * A role string cannot decide this: any app can name a node whatever it likes, and
	 * the point of the marker is that the helper looked at the real attribute.
	 */
	secure: boolean;
	rect?: OutlineRect;
	focused: boolean;
	offscreen: boolean;
	pictureOnly: boolean;
	truncated: boolean;
	scrollExtent?: OutlineScrollExtent;
	text: OutlineText[];
	children: OutlineNode[];
	parent?: OutlineNode;
}

export interface Outline {
	lookId: string;
	root: OutlineNode;
	nodes: OutlineNode[];
	refToWireRef: Map<string, string>;
	wireRefToRef: Map<string, string>;
}

export interface LookImage {
	jpegBase64: string;
	mimeType?: "image/jpeg" | "image/png";
	width: number;
	height: number;
}

export interface LookWindow {
	windowId: number;
	rootRef?: string;
	kind?: string;
	framePoints: OutlineRect;
	scaleFactor: number;
	isModal: boolean;
	metadata?: Record<string, unknown>;
	role: string;
	subrole: string;
}

export interface LookResponse {
	lookId: string;
	capturedAt: number;
	window: LookWindow;
	image?: LookImage;
	outline: OutlineNode;
	timings: Record<string, number>;
	readText?: { requested?: "auto" | "always" | "never"; executed: boolean };
	parsedOutline?: Outline;
}

export interface OutlineSearchMatch {
	ref: string;
	role: string;
	label: string;
	actions: string[];
	path: string;
	matchReason?: "exact" | "prefix" | "substring" | "fuzzy" | "filter";
	score?: number;
	node: OutlineNode;
}

export type SerializedOutlineSearchMatch = Omit<OutlineSearchMatch, "node"> & { node?: never };

export interface FoldResult {
	text: string;
	renderedRefs: string[];
	nodeCount: number;
	fullUnfoldLineCount: number;
	truncated: boolean;
}

export type OutlineChange =
	| { type: "added"; ref: string; parent?: string; node: SerializedOutlineNode }
	| { type: "updated"; ref: string; path: string[]; fields: Partial<Omit<SerializedOutlineNode, "children">> }
	| { type: "removed"; ref: string; parent?: string };

export interface OutlineDiff {
	changes: OutlineChange[];
	changedNodeCount: number;
	fullNodeCount: number;
	useFullView: boolean;
	reason?: "root_replaced" | "change_budget_exceeded" | "identity_confidence_low";
}

export type SerializedOutlineNode = Omit<OutlineNode, "parent" | "children"> & { children: SerializedOutlineNode[] };

export interface SerializedOutline {
	lookId: string;
	root: SerializedOutlineNode;
}
