import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LookResponse } from "../outline.ts";
import type { PermissionStatus } from "../permissions.ts";

export type PlatformName = "macos" | "windows" | "linux";
/**
 * `l2` is window-targeted delivery through the platform's private event channel:
 * it does not move the system cursor or activate the app. Only apps on the
 * compatibility list may use it, and it fails closed with `foreground_required`.
 */
export type NativeInputDelivery = "hid" | "pid" | "l2";
export type ActOutcome = "worked" | "didnt" | "unknown";
/**
 * Best-effort presentation hint for a root. The seam guarantees only the
 * `window` vs transient distinction; specific transient kinds are display hints
 * and must never drive behavior in shared code. Platforms that need precise
 * distinctions internally should use native signals.
 */
export type PlatformRootKind = "window" | "menu" | "sheet" | "popover" | "dialog";

export interface PlatformDiagnostics {
	protocolVersion: number;
	architectureVersion?: number;
	invariants?: string[];
	pid: number;
	parentPid?: number;
	parentAppName?: string;
	parentBundleId?: string;
	parentPath?: string;
	executablePath?: string;
	os?: string;
	arch?: string;
	accessibility?: boolean;
	screenRecording?: boolean;
}

export interface PlatformReadyState {
	permissionStatus?: PermissionStatus;
	lastPermissionCheckAt: number;
	helperDiagnostics?: PlatformDiagnostics;
}

export interface PlatformRootQuery {
	pid?: number;
	title?: string;
}

export interface PlatformApp {
	appName: string;
	bundleId?: string;
	pid: number;
	isFrontmost?: boolean;
}

export interface FramePoints {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PlatformRoot {
	kind: PlatformRootKind;
	rootRef?: string;
	windowRef?: string;
	windowId?: number;
	pid?: number;
	appName?: string;
	bundleId?: string;
	title: string;
	role?: string;
	subrole?: string;
	zOrder: number;
	framePoints: FramePoints;
	scaleFactor: number;
	isOnscreen: boolean;
	isFocused: boolean;
	isMinimized: boolean;
	/** Best-effort; platforms without a main-window concept may mirror `isFocused`. */
	isMain: boolean;
	/** Platform-reported modality fact, including platform-specific modal/dialog/sheet signals. */
	isModal: boolean;
	metadata?: Record<string, unknown>;
}

export interface PlatformFrontmostResult {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle?: string;
	windowId?: number;
	rootRef?: string;
}

export interface PlatformFocusWindowResult {
	focused: boolean;
	alreadyFocused?: boolean;
	reason?: string;
}

export interface HelperActPerformed {
	grounding?: "description" | "coordinates" | "keyboard-events";
	/** `ax` means the platform accessibility API (AX on macOS, UIA on Windows). */
	delivery?: "ax" | NativeInputDelivery;
	refound?: boolean;
	/** Free-form diagnostic naming the platform's delta mechanism. */
	deltaSource?: string;
	selectionGrounding?: "ax" | "keyboard";
	transaction?: boolean;
	actionCount?: number;
	activated?: boolean;
	raised?: boolean;
	focused?: boolean;
	/** The frontmost app changed while the user was typing. */
	interferedWithUser?: boolean;
}

export interface PlatformRootDelta {
	change: "appeared" | "closed" | "focused";
	kind: string;
	ref?: string;
	title?: string;
	pid: number;
	isModal?: boolean;
	metadata?: Record<string, unknown>;
}

export interface HelperActResult {
	outcome: ActOutcome;
	performed?: HelperActPerformed;
	evidence?: Record<string, unknown>;
	error?: { code?: string; message?: string; whatIsThere?: unknown };
	rootDelta?: PlatformRootDelta[];
	steps?: HelperActResult[];
	stoppedAt?: number;
}

export interface PlatformTarget {
	pid?: number;
	windowId?: number;
	rootRef?: string;
}

export interface PlatformObserveRequest {
	target: PlatformTarget;
	/** Existing immutable look whose untouched refs/coordinate geometry survive a scoped refresh. */
	baseLookId?: string;
	readText: "auto" | "always" | "never";
	scopeRef?: string;
	maxDimension?: number;
	includeImage?: boolean;
}

export type PlatformActTarget = { ref: string } | { x: number; y: number } | { focus: PlatformPoint };
/** Every pasteboard item, with each declared type kept as raw bytes. */
export interface PlatformClipboardSnapshot {
	changeCount: number;
	totalBytes: number;
	items: Array<{ types: Array<{ type: string; dataBase64: string }> }>;
}

export interface PlatformClipboardRestore {
	restored: boolean;
	changeCount: number;
	items: number;
}

export type PlatformDeliveryPolicy = "ax_only" | "background_text" | "background" | "default" | "foreground";
type PlatformMouseButton = "left" | "right" | "middle";
type PlatformActDeliveryParam = { delivery?: NativeInputDelivery };
export type PlatformPoint = { x: number; y: number };

/**
 * Proof that the broker granted this write, checked by the native helper.
 *
 * Absent when there is no broker (`ROTOM_CU_BROKER=0`): the helper then has no
 * key and cannot check anything, which is the documented old behavior.
 */
export interface PlatformTakeoverInput {
	pid: number;
	/** App name shown on the border and in the trace; never user content. */
	label: string;
	/** Agent holding the foreground; the helper reports preemption for it. */
	agentId: string;
	lease?: HelperLease;
}

export interface HelperLease {
	token: string;
	/** Resource the token was issued for; the helper compares it with the target. */
	resourceKey: string;
}

export interface PlatformActRequestBase {
	lookId: string;
	lease?: HelperLease;
	pid?: number;
	/** Agent whose cursor should move; each agent gets its own cursor (F4). */
	cursorAgentId?: string;
	target: PlatformActTarget;
	policy: PlatformDeliveryPolicy;
}

export type PlatformActRequest = PlatformActRequestBase & (
	| { action: "press" | "click"; params: { button?: PlatformMouseButton; clickCount?: number } & PlatformActDeliveryParam }
	| { action: "setText"; params: { text: string } & PlatformActDeliveryParam }
	| { action: "typeText"; params: { text: string } & PlatformActDeliveryParam }
	| { action: "keypress"; params: { keys: string[] } & PlatformActDeliveryParam }
	| { action: "scroll"; params: { scrollX: number; scrollY: number } & PlatformActDeliveryParam }
	| { action: "drag"; params: { path: PlatformPoint[] } & PlatformActDeliveryParam }
	| { action: "moveMouse"; params: PlatformActDeliveryParam }
	| { action: "hover"; params: PlatformActDeliveryParam }
	| { action: "select"; params: { option?: string } & PlatformActDeliveryParam }
	| { action: "setChecked"; params: { checked: boolean } & PlatformActDeliveryParam }
	| { action: "expand" | "collapse"; params: PlatformActDeliveryParam }
	| { action: "scrollTo"; params: PlatformActDeliveryParam }
	| { action: "focus"; params: PlatformActDeliveryParam }
	| { action: "clear"; params: PlatformActDeliveryParam }
	| { action: "setValue"; params: { value: number } & PlatformActDeliveryParam }
	| { action: "showMenu"; params: PlatformActDeliveryParam }
);

export interface PlatformReadTextRequest {
	/** Observation that owns the element ref. Native backends must not resolve across observations. */
	lookId: string;
	elementRef: string;
	offset: number;
	limit: number;
}

export interface PlatformReadTextResponse {
	text: string;
	offset: number;
	limit: number;
	totalChars: number;
	hasMore: boolean;
}

export interface PlatformWaitForRequest extends PlatformTarget {
	lookId?: string;
	text?: string;
	role?: string;
	value?: string;
	scopeRef?: string;
	scopeExact?: boolean;
	gone: boolean;
	timeoutMs: number;
}

export interface PlatformWaitForResponse {
	found: boolean;
	gone?: boolean;
	timedOut?: boolean;
	nodeCount?: number;
}

/** Real user input seen by the helper's listen-only tap. */
export interface PlatformUserActivity {
	/** Milliseconds since the epoch, the same clock the broker compares against. */
	lastUserInputAt: number;
	/** Seconds since the last real user input, or -1 when none was seen yet. */
	idleSeconds: number;
	listening: boolean;
	userEventCount: number;
	agentEventCount: number;
}

export interface PlatformClipboardRead {
	text: string;
	truncated: boolean;
	available: boolean;
	changeCount: number;
}

export interface PlatformClipboardWrite {
	changed?: boolean;
	cleared?: boolean;
	changeCount: number;
	length?: number;
}

export interface PlatformAppLaunchResult {
	launched: boolean;
	alreadyRunning?: boolean;
	/** The launch outlived the request window; the app may still appear. */
	pending?: boolean;
	pid?: number;
	activated: boolean;
}

export interface PlatformAppQuitResult {
	quitRequested: boolean;
	terminated: boolean;
	forced: boolean;
	unsavedChangesMayBlock: boolean;
}

export type PlatformWindowMode = "list" | "move" | "resize" | "minimize" | "restore" | "maximize" | "list_displays";

export interface PlatformWindowMutationResult {
	outcome: ActOutcome;
	windowId?: number;
	pid?: number;
	before?: Record<string, unknown>;
	after?: Record<string, unknown>;
	activated: boolean;
	raised: boolean;
}

export interface PlatformDisplay {
	displayId: number;
	name: string;
	frame: FramePoints;
	visibleFrame: FramePoints;
	scaleFactor: number;
	isMain: boolean;
}

export type PlatformSystemSurfaceName = "notifications" | "menu_bar_extras" | "control_center" | "dock";

export interface PlatformSystemSurface {
	available: boolean;
	bundleId: string;
	pid?: number;
	roots: PlatformRoot[];
}

export interface ComputerUsePlatformBackend {
	name: PlatformName;
	/** Release process-local resources when the Pi session is torn down. */
	shutdown?(): void | Promise<void>;
	ensureReady(ctx: ExtensionContext, state: PlatformReadyState, signal?: AbortSignal): Promise<PlatformReadyState>;
	listApps(signal?: AbortSignal): Promise<PlatformApp[]>;
	listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRoot[]>;
	getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult>;
	/**
	 * Raise a window. This changes what the user sees, so it takes the
	 * `desktop-pid:<pid>` lease: the helper refuses the command without a token
	 * (review Q5). The lease is required, not optional, so a caller cannot forget it.
	 */
	focusWindow(target: PlatformTarget, signal: AbortSignal | undefined, lease: HelperLease): Promise<PlatformFocusWindowResult>;
	observe(request: PlatformObserveRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LookResponse>;
	act(request: PlatformActRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult>;
	/** Execute one-resource actions with one root baseline and one final settle. */
	actBatch?(requests: PlatformActRequest[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult>;
	readText(args: PlatformReadTextRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformReadTextResponse>;
	waitFor(args: PlatformWaitForRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformWaitForResponse>;
	isBrowserApp(appName: string, bundleId?: string): boolean;
	isChromeFamilyApp(appName: string, bundleId?: string): boolean;
	openBrowserLocation(target: { appName: string; bundleId?: string }, url: string, signal?: AbortSignal): Promise<boolean>;
	/** Listen-only user input telemetry; absent when the platform cannot provide it. */
	userActivity?(signal?: AbortSignal): Promise<PlatformUserActivity>;
	/** Show the takeover border and swallow Escape for the duration (L4). */
	takeoverBegin?(input: PlatformTakeoverInput, signal?: AbortSignal): Promise<void>;
	takeoverEnd?(signal?: AbortSignal): Promise<void>;
	clipboardGet?(signal?: AbortSignal): Promise<PlatformClipboardRead>;
	clipboardSet?(text: string, signal?: AbortSignal, lease?: HelperLease): Promise<PlatformClipboardWrite>;
	clipboardClear?(signal?: AbortSignal, lease?: HelperLease): Promise<PlatformClipboardWrite>;
	/** Capture every item and type, so a write can be undone exactly. */
	clipboardSnapshot?(signal?: AbortSignal): Promise<PlatformClipboardSnapshot>;
	/** Overwrites the clipboard, so it is a write: the lease is required (review Q5). */
	clipboardRestore?(snapshot: PlatformClipboardSnapshot, signal: AbortSignal | undefined, lease: HelperLease): Promise<PlatformClipboardRestore>;
	manageApps?(request: ({ mode: "launch"; bundleId?: string; path?: string; activates?: boolean } | { mode: "quit"; pid?: number; bundleId?: string; force?: boolean; timeoutMs?: number }) & { lease?: HelperLease }, signal?: AbortSignal): Promise<PlatformAppLaunchResult | PlatformAppQuitResult>;
	manageWindow?(request: { mode: PlatformWindowMode; pid?: number; windowId?: number; x?: number; y?: number; w?: number; h?: number; title?: string; lease?: HelperLease }, signal?: AbortSignal): Promise<PlatformWindowMutationResult | PlatformRoot[] | PlatformDisplay[]>;
	systemSurfaces?(surface: PlatformSystemSurfaceName | "all", signal?: AbortSignal): Promise<Record<string, PlatformSystemSurface>>;
}
