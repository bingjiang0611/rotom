import type { FindParams } from "../contract.ts";
import type { FramePoints } from "../platform/types.ts";

/**
 * One addressable window row.
 *
 * Shared by `find_roots` and the administration tools, which is why it lives
 * outside `bridge.ts` (review: the administration tools moved to `src/tools/`).
 */
export interface WindowRow {
	app: string;
	bundleId?: string;
	pid: number;
	kind: string;
	windowTitle: string;
	windowId?: number;
	windowRef: string;
	nativeWindowRef?: string;
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
	isModal: boolean;
	sheetCount?: number;
	role?: string;
	subrole?: string;
	pairing?: { confidence: "exact" | "high" | "low"; score: number };
	zOrder: number;
	browserUseAllowed: boolean;
	score: number;
	url?: string;
}

export interface ListWindowsDetails {
	tool: "find_roots";
	query: FindParams;
	totalMatches?: number;
	returned?: number;
	hasMore?: boolean;
	windows: WindowRow[];
	config: {
		browser_use: boolean;
		headless: boolean;
	};
}
