import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canRetryInForeground, outcomeAfterCheck, outcomeAfterObservedValues, prepareAction, type ActionState, type PreparedAction } from "./actions.ts";
import { cdpClickForContext, cdpDragForContext, cdpEvaluateForContext, cdpKeypressForContext, cdpMouseForContext, cdpNavigateContext, cdpScrollForContext, cdpSnapshotForContext, cdpTabForWindow, cdpTypeFocusedForContext, cdpTypeForContext, disconnectCdp, listCdpPageContexts, type CdpConsoleEntry, type CdpPageSnapshot } from "./cdp.ts";
import { getComputerUseConfig, isBrowserUseEnabled, isHeadlessMode, loadComputerUseConfig } from "./config.ts";
import { noteAfterAct, noteFromLook, noteRegionKeyForRef, renderNote, type WindowNote } from "./note.ts";
import { foldToBudget, graftScopedOutline, nodeByRef, outlineNodeLabel, outlineNodePath, rankedTextMatch, restoreOutline, searchOutline, searchOutlineRanked, serializeOutline, serializeOutlineNodeShallow, serializeOutlineSearchMatch, type LookResponse, type Outline, type OutlineChange, type OutlineNode, type OutlineSearchMatch, type SerializedOutline, type SerializedOutlineNode, type SerializedOutlineSearchMatch } from "./outline.ts";
import { applyOutputEnvelope, boundToolError, clearStoredOutputs, readStoredOutput, UI_TEXT_PAGE_CHARS } from "./output.ts";
import { AGENT_TOOL_NAMES, type ActParams, type EvaluateBrowserParams, type ExpandUiParams, type ImageMode, type InspectUiParams, type LaunchBrowserParams, type FindParams, type NavigateBrowserParams, type ObserveParams, type ObserveTargetParams, type ReadTextParams, type RootSelector, type SearchUiParams, type UiAction, type WaitForParams } from "./contract.ts";
import { toFiniteNumber } from "./platform/coerce.ts";
import { currentPlatformBackend } from "./platform/index.ts";
import type { FramePoints, HelperActPerformed, HelperActResult, NativeInputDelivery, PlatformActRequest, PlatformDeliveryPolicy as DeliveryPolicy, PlatformApp as HelperApp, PlatformDiagnostics, PlatformFrontmostResult as FrontmostResult, PlatformRoot as HelperWindow } from "./platform/types.ts";
import type { PermissionStatus } from "./permissions.ts";
import { LeaseUnavailableError, ResourceScheduler, StaleResourceStateError } from "./runtime.ts";
import { agentRegistrationFor } from "./broker/identity.ts";
import { ClientLeaseBroker, UnavailableLeaseBroker, connectLeaseBroker, shouldUseBroker } from "./broker/lease-broker.ts";
import type { BrokerClient } from "./broker/client.ts";
import type { ApprovalRequestEvent, BrokerEvent } from "./broker/protocol.ts";
import { processAncestry } from "./broker/identity.ts";
import { approvalCopy } from "./constants/copy.ts";
import { describeSensitiveMatch, matchSensitiveAction } from "./policy/sensitive.ts";
import { excludeHostRoots, hostTargetRefusal, resolveHostApp, type HostAppInfo } from "./policy/host-exclusion.ts";
import { backgroundDelivery } from "./policy/l2-compat.ts";
import { scoreWindow, shouldPreferForegroundModalWindow } from "./root-selection.ts";
import { SavedStates, type CurrentCapture, type CurrentTarget, type OperationState } from "./state.ts";
import { changesBetween, renderChanges, stabilizeRefs } from "./view.ts";
import { redactParams, TraceRecorder, type TraceEntry } from "./trace/recorder.ts";
import { exportTraceMarkdown } from "./trace/report.ts";
export type { ActParams, EvaluateBrowserParams, ExpandUiParams, ImageMode, InspectUiParams, LaunchBrowserParams, FindParams, MouseButtonName, NavigateBrowserParams, ObserveParams, ObserveTargetParams, ReadTextParams, RootSelector, SearchUiParams, StateTargetParams, UiAction, WaitForParams } from "./contract.ts";

interface ActivationFlags {
	activated: boolean;
	unminimized: boolean;
	raised: boolean;
}

type ExecutionVariant = "stealth" | "default";
type ActionDelivery = "ax" | NativeInputDelivery;
type ActOutcome = "worked" | "didnt" | "unknown";

interface ExecutionTrace {
	strategy:
		| "look"
		| "act"
		| "wait"
		| "browser_open_location"
		| "cdp_navigate";
	runtimeMode?: ExecutionVariant;
	variant?: ExecutionVariant;
	stealthCompatible?: boolean;
	delivery?: ActionDelivery;
	deliveryPolicy?: DeliveryPolicy;
	outcome?: ActOutcome;
	performed?: HelperActPerformed;
	evidence?: Record<string, unknown>;
	error?: HelperActResult["error"];
	rootDelta?: HelperActResult["rootDelta"];
	steps?: ExecutionTrace[];
	actionCount?: number;
	stoppedAt?: number;
	backgroundFirst?: boolean;
	escalatedToForeground?: boolean;
	escalationReason?: string;
	backgroundAttempt?: { outcome: "foreground_required" | "didnt"; reason: string };
	/** L1 = accessibility API, L2 = window-targeted events, L4 = foreground input. */
	deliveryLevel?: "L1" | "L2" | "L4";
	/** The frontmost app changed while the user was typing. */
	interferedWithUser?: boolean;
	/** The user stopped this agent through the broker or the helper menu. */
	stoppedByUser?: boolean;
	verification?: {
		status: "verified" | "preexisting" | "failed";
		text?: string;
		role?: string;
		value?: string;
		gone?: boolean;
		timeoutMs: number;
	};
}

interface ComputerUseDetails {
	tool: string;
	target: {
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId: number;
		windowRef?: string;
		nativeWindowRef?: string;
	};
	capture: {
		stateId: string;
		width: number;
		height: number;
		scaleFactor: number;
		timestamp: number;
		coordinateSpace: "window-relative-screenshot-pixels";
	};
	lookId?: string;
	view: "full" | "diff";
	baseStateId?: string;
	changes?: OutlineChange[];
	viewReason?: "root_replaced" | "change_budget_exceeded" | "identity_confidence_low";
	renderedOutline?: string;
	outline?: SerializedOutline;
	note?: WindowNote;
	activation: ActivationFlags;
	execution: ExecutionTrace;
	config?: {
		browser_use: boolean;
		headless: boolean;
	};
	helper?: PlatformDiagnostics;
	status?: "ok";
	axDiagnostics?: {
		reason?: string;
		message?: string;
		debug?: unknown;
	};
	/** Recent browser console messages/exceptions; only present when CDP is active. */
	console?: CdpConsoleEntry[];
	imageReason?:
		| "fallback_recovery"
		| "browser_ax_window_unavailable"
		| "no_ax_targets"
		| "sparse_ax_targets"
		| "weak_ax_targets"
		| "unlabeled_ax_targets"
		| "duplicated_ax_labels"
		| "browser_wait_verification";
}
/** Structured refusal from the cross-process write arbiter. */
interface LeaseConflictDetails {
	tool: string;
	status: "lease_conflict";
	code: "resource_busy" | "denied" | "approval_unavailable" | "approval_denied" | "stopped_by_user" | "broker_unavailable";
	message: string;
	leaseHolder?: { agentId: string; remainingMs: number };
	retry: "safe" | "unsafe" | "never";
}

interface TerminalDesktopActionDetails {
	tool: "act_ui";
	status: "target_closed" | "post_action_observation_failed";
	baseStateId: string;
	target: {
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId: number;
		windowRef?: string;
		nativeWindowRef?: string;
	};
	execution: ExecutionTrace;
	error: { code: string; message: string };
}


interface ListWindowsDetails {
	tool: "find_roots";
	query: FindParams;
	totalMatches?: number;
	returned?: number;
	hasMore?: boolean;
	windows: Array<{
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
	}>;
	config: {
		browser_use: boolean;
		headless: boolean;
	};
}

interface BrowserObservationDetails {
	tool: string;
	kind: "browser_page";
	stateId: string;
	baseStateId?: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	root: { ref: string; kind: "browser_page"; title: string; url: string };
	outline: SerializedOutline;
	renderedOutline: string;
}

interface EvaluateBrowserDetails {
	tool: "evaluate_browser";
	baseStateId: string;
	stateId: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	outline: SerializedOutline;
	renderedOutline: string;
}

interface ReadTextDetails {
	tool: "read_text";
	ref?: string;
	offset: number;
	limit: number;
	totalChars?: number;
	totalBytes?: number;
	hasMore: boolean;
	complete?: boolean;
	text: string;
}

interface WaitForDetails {
	tool: "wait_for";
	stateId: string;
	baseStateId?: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	found: boolean;
	gone?: boolean;
	timedOut?: boolean;
	target?: SerializedOutlineSearchMatch;
	nodeCount?: number;
	text?: string;
	role?: string;
	value?: string;
	scopeRef?: string;
	outline: SerializedOutline;
	renderedOutline: string;
}

interface OutlineToolDetails {
	tool: "search_ui" | "expand_ui" | "inspect_ui";
	stateId?: string;
	lookId?: string;
	outline?: SerializedOutline;
	renderedOutline?: string;
	totalMatches?: number;
	returned?: number;
	hasMore?: boolean;
	matches?: SerializedOutlineSearchMatch[];
	target?: SerializedOutlineNode;
	note?: WindowNote;
}

interface ResolvedTarget extends CurrentTarget {
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

interface WindowRefRecord {
	ref: string;
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId?: number;
	nativeWindowRef?: string;
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

interface RuntimeState {
	windowRefs: Map<string, WindowRefRecord>;
	windowRefByIdentity: Map<string, string>;
	browserRootByContext: Map<string, string>;
	browserContextByRoot: Map<string, string>;
	nextRootRefIndex: number;
	managedBrowser?: ChildProcess;
	managedBrowserCdpPort?: string;
	previousCdpPort?: string;
	permissionStatus?: PermissionStatus;
	helperDiagnostics?: PlatformDiagnostics;
	lastPermissionCheckAt: number;
	/** Agent identity shared with the broker, reused for the trace file name. */
	agentId?: string;
}


const MISSING_TARGET_ERROR = "No current controlled window. Call observe_ui first to choose a target window.";
const CURRENT_TARGET_GONE_ERROR =
	"The current controlled window is no longer available. Call observe_ui to choose a new target window.";

const COMMAND_TIMEOUT_MS = 15_000;
const LOOK_TIMEOUT_MS = 33_000;

const ACTION_SETTLE_MS = 280;

const BROWSER_CONTEXT_PREFIX = "browser:";
const MANAGED_BROWSER_READY_TIMEOUT_MS = 15_000;
const AUTO_IMAGE_MAX_DIMENSION = 900;
const EXPLICIT_IMAGE_MAX_DIMENSION = 1_600;
const BROWSER_TRANSACTION_ACTIONS = new Set<UiAction["action"]>(["press", "click", "setText", "typeText", "keypress", "scroll", "drag", "moveMouse"]);

const runtimeState: RuntimeState = {
	lastPermissionCheckAt: 0,
	windowRefs: new Map(),
	windowRefByIdentity: new Map(),
	browserRootByContext: new Map(),
	browserContextByRoot: new Map(),
	nextRootRefIndex: 1,
};

const savedStates = new SavedStates();
let resourceScheduler = new ResourceScheduler();
let brokerSession: { broker: ClientLeaseBroker; client: BrokerClient } | undefined;
/** Set when the user stops this agent from the helper status item or broker. */
let brokerStopRequested = false;
/** Recent revocations, so a batch can report why its write authority disappeared. */
const brokerRevocations: Array<{ reason: string; leaseIds: string[]; at: number }> = [];

function operationState(): OperationState {
	return savedStates.current();
}

function desktopResourceKey(target: Pick<CurrentTarget, "pid">): string {
	return `desktop-pid:${target.pid}`;
}

function persistOperation(state: OperationState): void {
	if (!state.currentTarget || !state.currentCapture || !state.currentLook || !state.currentOutline) return;
	const resourceKey = state.resourceKey ?? desktopResourceKey(state.currentTarget);
	const epoch = state.epoch ?? resourceScheduler.epoch(resourceKey);
	savedStates.saveDesktop(state, resourceKey, epoch);
}

/** Release handles and state owned by the current Pi session. */
export async function shutdownComputerUseSession(): Promise<void> {
	await resourceScheduler.close();
	if (brokerSession) {
		await brokerSession.broker.releaseAll();
		brokerSession.client.close();
		brokerSession = undefined;
	}
	brokerStopRequested = false;
	brokerRevocations.length = 0;
	resourceScheduler = new ResourceScheduler();
	disconnectCdp();

	const managedBrowser = runtimeState.managedBrowser;
	runtimeState.managedBrowser = undefined;
	if (managedBrowser) {
		managedBrowser.kill("SIGTERM");
		managedBrowser.unref();
	}
	if (runtimeState.managedBrowserCdpPort && process.env.PI_COMPUTER_USE_CDP_PORT === runtimeState.managedBrowserCdpPort) {
		if (runtimeState.previousCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
		else process.env.PI_COMPUTER_USE_CDP_PORT = runtimeState.previousCdpPort;
	}
	runtimeState.managedBrowserCdpPort = undefined;
	runtimeState.previousCdpPort = undefined;

	savedStates.clear();
	clearStoredOutputs();
	runtimeState.windowRefs.clear();
	runtimeState.windowRefByIdentity.clear();
	runtimeState.browserRootByContext.clear();
	runtimeState.browserContextByRoot.clear();
	runtimeState.nextRootRefIndex = 1;
	runtimeState.permissionStatus = undefined;
	runtimeState.helperDiagnostics = undefined;
	runtimeState.lastPermissionCheckAt = 0;
	await currentPlatformBackend.shutdown?.();
}

function currentRuntimeMode(): ExecutionVariant {
	return isHeadlessMode() ? "stealth" : "default";
}

function currentDeliveryPolicy(): DeliveryPolicy {
	if (isHeadlessMode()) return process.platform === "darwin" ? "background_text" : "ax_only";
	const value = (process.env.PI_COMPUTER_USE_DELIVERY_POLICY ?? process.env.PI_COMPUTER_USE_EVENT_DELIVERY ?? "default").toLowerCase();
	return value === "background" || value === "pid" ? "background" : value === "foreground" || value === "hid" ? "foreground" : value === "ax_only" || value === "ax-only" ? "ax_only" : "default";
}

function nativeInputDelivery(policy = currentDeliveryPolicy(), target?: Pick<ResolvedTarget, "bundleId" | "appName">): NativeInputDelivery {
	if (policy === "foreground") return "hid";
	// Whitelisted apps get the window-targeted channel; everything else keeps
	// pid-targeted posting. L2 fails closed with `foreground_required` when the
	// platform build lacks the delivery symbol.
	if (policy === "background" && target) return backgroundDelivery(target.bundleId, target.appName);
	return "pid";
}

function executionTrace(
	strategy: ExecutionTrace["strategy"],
	variant: ExecutionVariant,
	metadata: Omit<ExecutionTrace, "strategy" | "runtimeMode" | "variant" | "stealthCompatible"> = {},
): ExecutionTrace {
	return {
		strategy,
		runtimeMode: currentRuntimeMode(),
		variant,
		stealthCompatible: variant === "stealth",
		...metadata,
	};
}

function settleMsForExecution(execution: ExecutionTrace): number {
	// Any deltaSource means the helper already awaited UI quiescence; the
	// bridge must not double-pay with its own settle sleep.
	if (execution.performed?.deltaSource) return 0;
	if (execution.variant === "stealth") {
		switch (execution.strategy) {
			case "browser_open_location":
				return 120;
			default:
				return 120;
		}
	}
	return ACTION_SETTLE_MS;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted.");
	}
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const onAbort = () => {
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface LeaseContext {
	action?: { name: string; label?: string };
}

function leaseApp(target: ResolvedTarget | CurrentTarget) {
	return { appName: target.appName, bundleId: target.bundleId };
}

async function withWindowWriteLock<T>(target: ResolvedTarget | CurrentTarget, work: () => Promise<T>, lease?: LeaseContext): Promise<T> {
	const state = operationState();
	const key = desktopResourceKey(target);
	const baseEpoch = state.epoch ?? await resourceScheduler.syncEpoch(key);
	const result = await resourceScheduler.write(key, baseEpoch, async (nextEpoch) => {
		state.resourceKey = key;
		state.epoch = nextEpoch;
		return await work();
	}, { action: lease?.action, app: leaseApp(target) });
	return result.value;
}


function trimOrUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeText(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function toBoolean(value: unknown): boolean {
	return value === true;
}

function outlineNodeCenter(node: OutlineNode): { x: number; y: number } {
	if (!node.rect) {
		throw new Error(`Outline ref '${node.ref}' has no full-look coordinates after scoped expansion. Re-observe for coordinates.`);
	}
	return { x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2 };
}

function validateStateId(stateId?: string): CurrentCapture {
	const state = operationState();
	if (!state.currentCapture) {
		throw new Error("No observation state is available. Call observe_ui first.");
	}
	const supplied = stateId;
	if (supplied && state.currentCapture.stateId !== supplied) {
		throw new Error(
			`Stale state '${supplied}'. The active operation state is '${state.currentCapture.stateId}'. Observe the root again and retry.`,
		);
	}
	const stateTarget = state.currentStateTarget;
	if (stateTarget && state.currentTarget && (stateTarget.pid !== state.currentTarget.pid || stateTarget.windowId !== state.currentTarget.windowId)) {
		throw new Error("The latest state belongs to a different window. Call observe_ui for the target window and retry.");
	}
	return state.currentCapture;
}

function formatOutlineNodeLabel(node: OutlineNode): string {
	const label = outlineNodeLabel(node) || "(unlabeled)";
	const identifier = node.identifier ? ` id=${JSON.stringify(node.identifier)}` : "";
	const capabilities = [
		node.canSetValue ? "setValue" : undefined,
		node.canPress ? "press" : undefined,
		node.canFocus ? "focus" : undefined,
		node.canScroll ? "scroll" : undefined,
		node.canIncrement || node.canDecrement ? "adjust" : undefined,
		node.pictureOnly ? "pictureOnly" : undefined,
	].filter((item): item is string => Boolean(item));
	return `${node.ref} ${node.role}${node.subrole ? `/${node.subrole}` : ""}${identifier} ${JSON.stringify(label)}${capabilities.length ? ` [${capabilities.join(",")}]` : ""}`;
}

function outlineNodeByRef(ref: string): OutlineNode {
	const state = operationState();
	const outline = state.currentOutline;
	const node = outline ? nodeByRef(outline, ref) : undefined;
	if (!node) {
		const windowHint = state.currentTarget?.windowRef ? `({ root: "${state.currentTarget.windowRef}" })` : "";
		throw new Error(`Outline ref '${ref}' is stale or not available for the latest state. Call observe_ui${windowHint} again and choose a current @e ref.`);
	}
	return node;
}

function wireRefForNode(node: OutlineNode): string {
	if (node.pictureOnly || !node.wireRef) {
		throw new Error(`Outline ref '${node.ref}' is pictureOnly and has no semantic element. It can be clicked by coordinates, but semantic-only actions are not available.`);
	}
	return node.wireRef;
}

function imageFallbackReason(
	tool: string,
	result: CaptureResult,
	imageMode: ImageMode = "auto",
): { reason: NonNullable<ComputerUseDetails["imageReason"]>; message: string } | undefined {
	if (imageMode === "never") return undefined;
	if (imageMode === "always") return { reason: "fallback_recovery", message: "An image was requested explicitly for visual verification." };
	const outline = result.outline;
	const labeled = outline.nodes.filter((node) => outlineNodeLabel(node)).length;
	if (outline.nodes.length < 3) {
		return { reason: "sparse_ax_targets", message: "Only a few outline nodes were found, so the look image is attached for context." }
	}
	if (labeled * 3 < outline.nodes.length) {
		return { reason: "unlabeled_ax_targets", message: "Most outline nodes are unlabeled, so the look image is attached for context." }
	}
	if (tool === "wait" && currentPlatformBackend.isBrowserApp(result.target.appName, result.target.bundleId)) {
		return { reason: "browser_wait_verification", message: "Browser content may have changed visually during wait, so an image is attached for fallback." }
	}
	return undefined
}

function currentTargetOrThrow(): CurrentTarget {
	const target = operationState().currentTarget;
	if (!target) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	return target;
}

function emptyActivation(): ActivationFlags {
	return { activated: false, unminimized: false, raised: false };
}

async function ensureReady(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	loadComputerUseConfig(ctx.cwd);

	throwIfAborted(signal);
	const ready = await currentPlatformBackend.ensureReady(
		ctx,
		{
			permissionStatus: runtimeState.permissionStatus,
			lastPermissionCheckAt: runtimeState.lastPermissionCheckAt,
			helperDiagnostics: runtimeState.helperDiagnostics,
		},
		signal,
	);
	runtimeState.permissionStatus = ready.permissionStatus;
	runtimeState.lastPermissionCheckAt = ready.lastPermissionCheckAt;
	runtimeState.helperDiagnostics = ready.helperDiagnostics;
}

export async function ensureComputerUseSetup(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	await ensureReady(ctx, signal);
}

/**
 * Attach this Pi process to the Desktop Broker.
 *
 * Must run for headless (subagent) sessions too: they are exactly the processes
 * that would otherwise fight over the same app. When the broker cannot be
 * reached, writes fail closed with `broker_unavailable` instead of silently
 * falling back to process-local epochs.
 */
export async function ensureComputerUseBroker(ctx: ExtensionContext): Promise<void> {
	if (brokerSession) return;
	if (!shouldUseBroker({ platform: process.platform, configured: getComputerUseConfig().broker })) return;
	const registration = agentRegistrationFor({
		sessionId: typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined,
		hasUI: ctx.hasUI,
		cwd: ctx.cwd,
	});
	agentPidChain = registration.pidChain;
	runtimeState.agentId = registration.agentId;
	brokerStopRequested = false;
	try {
		brokerSession = await connectLeaseBroker({
			...registration,
			onEvent: (event: BrokerEvent) => {
				if (event.event === "stopped") brokerStopRequested = true;
				if (event.event === "revoked") {
					brokerRevocations.push({ reason: event.reason, leaseIds: event.leaseIds, at: Date.now() });
					while (brokerRevocations.length > 8) brokerRevocations.shift();
				}
			},
			onApproval: createBrokerApprovalHandler(ctx, registration.cwd),
		});
		resourceScheduler.setBroker(brokerSession.broker);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		resourceScheduler.setBroker(new UnavailableLeaseBroker(`The Desktop Broker is unavailable: ${message}`));
		if (ctx.hasUI) ctx.ui.notify(`Computer Use broker unavailable: ${message}`, "warning");
	}
}

/**
 * Turn a broker approval request into the user's three-way decision.
 *
 * This runs only in the UI-capable session the broker routed to; the model never
 * sees the card and has no tool that can answer it.
 */
function createBrokerApprovalHandler(ctx: ExtensionContext, cwd: string | undefined) {
	void cwd;
	const options = approvalCopy.options();
	return async (event: ApprovalRequestEvent): Promise<"allow_session" | "always" | "deny"> => {
		if (!ctx.hasUI) return "deny";
		const sensitive = matchSensitiveAction(event.action);
		const choice = await ctx.ui.select(approvalCopy.title({
			app: event.app?.appName ?? event.app?.bundleId ?? event.resourceKey,
			tier: event.tier,
			action: `Action: ${event.action?.name ?? "unknown"}`,
			label: event.action?.label,
			sensitive: sensitive ? describeSensitiveMatch(sensitive) : undefined,
			warning: event.warning,
		}), [...options]);
		if (choice === approvalCopy.allowAlways) return "always";
		if (choice === approvalCopy.allowSession) return "allow_session";
		return "deny";
	};
}

/** True once the user stopped this agent; a batch must end at its next step boundary. */
export function computerUseStopRequested(): boolean {
	return brokerStopRequested;
}

let hostAppCache: { value: HostAppInfo | undefined; at: number } | undefined;
let traceRecorder: TraceRecorder | undefined;
let traceRecorderKey: string | undefined;

/**
 * Trace recorder for this session, created on first tool call.
 *
 * Disabled by config (`trace: false`) or `ROTOM_CU_TRACE=0`. Never throws: a
 * trace that cannot be written must not change what the agent did.
 */
function sessionTrace(ctx: ExtensionContext): TraceRecorder | undefined {
	const config = getComputerUseConfig();
	if (!config.trace) return undefined;
	const sessionId = typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "no-session";
	const key = `${sessionId}|${runtimeState.agentId ?? "local"}`;
	if (traceRecorder && traceRecorderKey === key) return traceRecorder;
	traceRecorder?.close();
	traceRecorderKey = key;
	traceRecorder = TraceRecorder.create({
		sessionId: sessionId || "no-session",
		agentId: runtimeState.agentId ?? `process:${process.pid}`,
		enabled: true,
	});
	return traceRecorder;
}
/** Ancestor pids captured when the broker registration was built. */
let agentPidChain: number[] | undefined;

/**
 * The app that hosts this session (terminal or IDE), excluded from observation
 * and refused as a target. Resolved from the process ancestry, cached briefly
 * because the answer cannot change while the process lives.
 */
async function hostApplication(signal?: AbortSignal): Promise<HostAppInfo | undefined> {
	if (hostAppCache && Date.now() - hostAppCache.at < 30_000) return hostAppCache.value;
	const chain = agentPidChain ?? processAncestry();
	const apps = await listApps(signal).catch(() => []);
	const value = resolveHostApp(apps, chain);
	hostAppCache = { value, at: Date.now() };
	return value;
}

async function listApps(signal?: AbortSignal): Promise<HelperApp[]> {
	return await currentPlatformBackend.listApps(signal);
}

async function listWindows(pid: number, signal?: AbortSignal): Promise<HelperWindow[]> {
	return await currentPlatformBackend.listRoots({ pid }, signal);
}

function appMatchesWindowQuery(app: HelperApp, query: FindParams): boolean {
	const appQuery = trimOrUndefined(query.app);
	const bundleQuery = trimOrUndefined(query.bundleId);
	const pidQuery = Number.isFinite(query.pid) ? Math.trunc(query.pid!) : undefined;

	if (pidQuery !== undefined && app.pid !== pidQuery) return false;
	if (bundleQuery && normalizeText(app.bundleId ?? "") !== normalizeText(bundleQuery)) return false;
	if (appQuery && normalizeText(app.appName) !== normalizeText(appQuery)) return false;
	return true;
}

function platformRootSheetCount(window: Pick<HelperWindow, "metadata">): number | undefined {
	const value = window.metadata?.sheetCount;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function platformRootPairing(window: Pick<HelperWindow, "metadata">): { confidence: "exact" | "high" | "low"; score: number } | undefined {
	const value = window.metadata?.pairing;
	if (!value || typeof value !== "object") return undefined;
	const pairing = value as { confidence?: unknown; score?: unknown };
	if (pairing.confidence !== "exact" && pairing.confidence !== "high" && pairing.confidence !== "low") return undefined;
	return { confidence: pairing.confidence, score: typeof pairing.score === "number" && Number.isFinite(pairing.score) ? pairing.score : Number.NEGATIVE_INFINITY };
}

function formatWindowLine(window: ListWindowsDetails["windows"][number]): string {
	if (window.kind === "browser_page") return `- ${window.windowRef} browser_page ${JSON.stringify(window.windowTitle)}${window.url ? ` — ${window.url}` : ""}`;
	const flags = [
		window.isFocused ? "focused" : undefined,
		window.isMain ? "main" : undefined,
		window.isModal ? "modal" : undefined,
		window.sheetCount ? `sheets=${window.sheetCount}` : undefined,
		window.isOnscreen ? "onscreen" : undefined,
		window.isMinimized ? "minimized" : undefined,
		window.browserUseAllowed ? undefined : "browser_use_disabled",
	]
		.filter(Boolean)
		.join(", ");
	const frame = `${Math.round(window.framePoints.x)},${Math.round(window.framePoints.y)} ${Math.round(window.framePoints.w)}x${Math.round(window.framePoints.h)}`;
	const id = window.windowId ? `windowId ${window.windowId}` : window.nativeWindowRef ? `nativeRootRef ${window.nativeWindowRef}` : "unstable root id";
	const pairing = window.pairing ? `, pairing ${window.pairing.confidence}/${Math.round(window.pairing.score)}` : "";
	return `- ${window.windowRef} ${window.kind} ${window.app} pid ${window.pid} — ${window.windowTitle || "(untitled)"} (z ${window.zOrder}, ${id}, frame ${frame}${pairing}${flags ? `, ${flags}` : ""})`;
}

async function getFrontmost(signal?: AbortSignal): Promise<FrontmostResult> {
	return await currentPlatformBackend.getFrontmost(signal);
}

function assertBrowserUseAllowed(target: { appName: string; bundleId?: string }): void {
	if (!isBrowserUseEnabled() && currentPlatformBackend.isBrowserApp(target.appName, target.bundleId)) {
		throw new Error(
			`Browser use is disabled by pi-computer-use config, so '${target.appName}' cannot be controlled. Enable browser_use in ~/.pi/agent/extensions/pi-computer-use.json or .pi/computer-use.json to allow browser windows.`,
		);
	}
}

function windowRecordIdentity(record: Pick<WindowRefRecord, "pid" | "windowId" | "nativeWindowRef" | "windowTitle" | "framePoints">): string {
	if (record.windowId && record.windowId > 0) {
		return `pid:${record.pid}|id:${record.windowId}`;
	}
	if (record.nativeWindowRef) {
		return `pid:${record.pid}|ref:${record.nativeWindowRef}`;
	}
	const { x, y, w, h } = record.framePoints;
	return `pid:${record.pid}|title:${normalizeText(record.windowTitle)}|frame:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}

function storeWindowRef(record: Omit<WindowRefRecord, "ref">): WindowRefRecord {
	const identity = windowRecordIdentity(record);
	const existingRef = runtimeState.windowRefByIdentity.get(identity);
	if (existingRef) {
		const existing = runtimeState.windowRefs.get(existingRef);
		if (existing) {
			const updated = { ...record, ref: existingRef };
			runtimeState.windowRefs.set(existingRef, updated);
			return updated;
		}
	}

	const ref = `@r${runtimeState.nextRootRefIndex++}`;
	const stored = { ...record, ref };
	runtimeState.windowRefByIdentity.set(identity, ref);
	runtimeState.windowRefs.set(ref, stored);
	return stored;
}

function storeBrowserRootRef(contextId: string): string {
	const existing = runtimeState.browserRootByContext.get(contextId);
	if (existing) return existing;
	const ref = `@r${runtimeState.nextRootRefIndex++}`;
	runtimeState.browserRootByContext.set(contextId, ref);
	runtimeState.browserContextByRoot.set(ref, contextId);
	return ref;
}

function storeWindowRefForTarget(target: ResolvedTarget): string {
	return storeWindowRef({
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
		windowTitle: target.windowTitle,
		windowId: target.windowId > 0 ? target.windowId : undefined,
		framePoints: target.framePoints,
		scaleFactor: target.scaleFactor,
		isMinimized: target.isMinimized,
		isOnscreen: target.isOnscreen,
		isMain: target.isMain,
		isFocused: target.isFocused,
	}).ref;
}

function storeWindowRefForAppWindow(app: HelperApp, window: HelperWindow): WindowRefRecord {
	return storeWindowRef({
		appName: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		windowTitle: window.title || "(untitled)",
		windowId: window.windowId,
		nativeWindowRef: window.windowRef,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
	});
}

function choosePreferredWindow(windows: HelperWindow[], appName: string): HelperWindow {
	if (!windows.length) {
		throw new Error(`No controllable root was found in app '${appName}'.`);
	}

	const scored = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	return scored[0];
}

function summarizeWindowCandidate(window: HelperWindow): string {
	const flags = [
		window.isFocused ? "focused" : undefined,
		window.isMain ? "main" : undefined,
		window.isOnscreen ? "onscreen" : undefined,
		window.isMinimized ? "minimized" : undefined,
	]
		.filter(Boolean)
		.join(",");
	return `${window.title || "(untitled)"} [score=${scoreWindow(window)}${flags ? `, ${flags}` : ""}]`;
}

function summarizeWindowCandidates(windows: HelperWindow[], limit = 6): string {
	return [...windows]
		.sort((a, b) => scoreWindow(b) - scoreWindow(a))
		.slice(0, limit)
		.map(summarizeWindowCandidate)
		.join("; ");
}

function chooseRankedWindowOrUndefined(windows: HelperWindow[]): HelperWindow | undefined {
	if (windows.length === 0) return undefined;
	const ranked = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	if (ranked.length === 1) return ranked[0];
	const topScore = scoreWindow(ranked[0]);
	const nextScore = scoreWindow(ranked[1]);
	return topScore >= nextScore + 25 ? ranked[0] : undefined;
}

function toResolvedTarget(app: HelperApp, window: HelperWindow): ResolvedTarget {
	const baseTarget = {
		appName: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		windowTitle: window.title || "(untitled)",
		windowId: typeof window.windowId === "number" ? window.windowId : 0,
		nativeWindowRef: window.windowRef,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
	};
	return { ...baseTarget, windowRef: storeWindowRefForAppWindow(app, window).ref };
}

function nativeWindowRequest(target: Pick<CurrentTarget, "pid" | "windowId" | "nativeWindowRef">): { pid: number; windowId: number; windowRef?: string } {
	return { pid: target.pid, windowId: target.windowId, windowRef: target.nativeWindowRef };
}

function setCurrentTarget(target: ResolvedTarget): void {
	assertBrowserUseAllowed(target);
	const windowRef = target.windowRef ?? storeWindowRefForTarget(target);
	operationState().currentTarget = {
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
		windowTitle: target.windowTitle,
		windowId: target.windowId,
		windowRef,
		nativeWindowRef: target.nativeWindowRef,
	};
}

function normalizeWindowSelector(selector: RootSelector | undefined): string | undefined {
	if (typeof selector === "number" && Number.isFinite(selector)) return String(Math.trunc(selector));
	if (typeof selector === "string") return trimOrUndefined(selector);
	return undefined;
}

async function resolveTargetByWindowSelector(selector: RootSelector, signal?: AbortSignal): Promise<ResolvedTarget> {
	const normalized = normalizeWindowSelector(selector);
	if (!normalized) {
		throw new Error("root target must be a non-empty @r ref or numeric windowId.");
	}

	const current = operationState().currentTarget;
	if (current?.windowRef === normalized) {
		return await resolveCurrentTarget(signal);
	}

	const fromRef = runtimeState.windowRefs.get(normalized);
	if (fromRef) {
		const app: HelperApp = { appName: fromRef.appName, bundleId: fromRef.bundleId, pid: fromRef.pid };
		const windows = await listWindows(fromRef.pid, signal);
		const match =
			(fromRef.windowId ? windows.find((window) => window.windowId === fromRef.windowId) : undefined) ??
			(fromRef.nativeWindowRef ? windows.find((window) => window.windowRef === fromRef.nativeWindowRef) : undefined) ??
			windows.find((window) => normalizeText(window.title || "(untitled)") === normalizeText(fromRef.windowTitle));
		if (!match) {
			throw new Error(`Root ref '${normalized}' is stale. Call find_roots again and choose a current window.`);
		}
		const resolved = toResolvedTarget(app, match);
		setCurrentTarget(resolved);
		return resolved;
	}

	const numericWindowId = Number(normalized);
	if (Number.isInteger(numericWindowId) && numericWindowId > 0) {
		const apps = await listApps(signal);
		for (const app of apps) {
			const windows = await listWindows(app.pid, signal);
			const match = windows.find((window) => window.windowId === numericWindowId);
			if (match) {
				assertBrowserUseAllowed(app);
				const resolved = toResolvedTarget(app, match);
				setCurrentTarget(resolved);
				return resolved;
			}
		}
		throw new Error(`Window id '${numericWindowId}' was not found. Call find_roots again and choose a current window.`);
	}

	if (normalized.startsWith("@r")) {
		throw new Error(`Root ref '${normalized}' is not available in this session. Call find_roots first.`);
	}

	const config = getComputerUseConfig();
	const candidates = await collectWindowDetails(await listApps(signal), config, signal);
	const query = normalizeText(normalized);
	const exact = candidates.filter((candidate) => normalizeText(candidate.app) === query || normalizeText(candidate.windowTitle) === query);
	const fuzzy = exact.length > 0 ? exact : candidates.filter((candidate) => `${normalizeText(candidate.app)} ${normalizeText(candidate.windowTitle)}`.includes(query));
	const match = fuzzy.sort((a, b) => Number(b.isFocused) - Number(a.isFocused) || a.zOrder - b.zOrder)[0];
	if (!match) throw new Error(`Root query '${normalized}' did not match any current root. Call find_roots to inspect roots.`);
	const app: HelperApp = { appName: match.app, bundleId: match.bundleId, pid: match.pid };
	const roots = await listWindows(match.pid, signal);
	const helperRoot = roots.find((root) => root.rootRef === match.nativeWindowRef || root.windowRef === match.nativeWindowRef || root.windowId === match.windowId) ?? roots[0];
	const resolved = toResolvedTarget(app, helperRoot);
	setCurrentTarget(resolved);
	return resolved;
}

async function resolveCurrentTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
	const current = currentTargetOrThrow();
	const host = await hostApplication(signal);
	if (host && (current.pid === host.pid || (host.bundleId && current.bundleId === host.bundleId))) throw new Error(hostTargetRefusal(host));
	const windows = await listWindows(current.pid, signal);
	if (!windows.length) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const hadStableWindowId = current.windowId > 0;
	const titleQuery = normalizeText(current.windowTitle);
	let match = current.nativeWindowRef ? windows.find((window) => window.windowRef === current.nativeWindowRef || window.rootRef === current.nativeWindowRef) : undefined;
	match ??= hadStableWindowId ? windows.find((window) => window.windowId !== undefined && window.windowId === current.windowId) : undefined;
	if (!match) {
		const exactTitleMatches = titleQuery && titleQuery !== "(untitled)" ? windows.filter((window) => normalizeText(window.title) === titleQuery) : [];
		if (exactTitleMatches.length === 1) {
			match = exactTitleMatches[0];
		} else if (exactTitleMatches.length > 1) {
			match = chooseRankedWindowOrUndefined(exactTitleMatches);
			if (!match) {
				throw new Error(
					`${CURRENT_TARGET_GONE_ERROR} Multiple windows now match '${current.windowTitle}': ${summarizeWindowCandidates(exactTitleMatches)}.`,
				);
			}
		}
	}

	if (!match && !hadStableWindowId) {
		match = chooseRankedWindowOrUndefined(windows);
	}

	if (!match) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const modal = windows
		.filter((window) => shouldPreferForegroundModalWindow(match!, window))
		.sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
	if (modal) match = modal;

	const app: HelperApp = {
		appName: current.appName,
		bundleId: current.bundleId,
		pid: current.pid,
	};

	const resolved = toResolvedTarget(app, match);
	setCurrentTarget(resolved);
	return resolved;
}

async function resolveFrontmostTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
	const frontmost = await getFrontmost(signal);
	const apps = await listApps(signal);
	const app = apps.find((candidate) => candidate.pid === frontmost.pid) ?? {
		appName: frontmost.appName,
		bundleId: frontmost.bundleId,
		pid: frontmost.pid,
	};

	const windows = await listWindows(frontmost.pid, signal);
	if (!windows.length) {
		throw new Error("No frontmost controllable root was found. Open an app window and call observe_ui again.");
	}

	if (currentPlatformBackend.isBrowserApp(app.appName, app.bundleId)) {
		assertBrowserUseAllowed(app);
	}

	let selected = windows.find((window) => window.windowId !== undefined && window.windowId === frontmost.windowId);
	if (!selected && frontmost.windowTitle) {
		selected = windows.find((window) => normalizeText(window.title) === normalizeText(frontmost.windowTitle));
	}
	selected ??= choosePreferredWindow(windows, app.appName);

	const resolved = toResolvedTarget(app, selected);
	setCurrentTarget(resolved);
	return resolved;
}

function matchesObserveSelection(target: ResolvedTarget, selection: ObserveTargetParams): boolean {
	const root = normalizeWindowSelector(selection.root);
	return !root || target.windowRef === root;
}

async function resolveTargetForObserve(signal?: AbortSignal): Promise<ResolvedTarget> {
	return operationState().currentTarget ? await resolveCurrentTarget(signal) : await resolveFrontmostTarget(signal);
}

async function ensureTargetWindowId(target: ResolvedTarget, signal?: AbortSignal): Promise<ResolvedTarget> {
	if (target.windowId > 0 || target.nativeWindowRef) {
		return target;
	}

	const refreshed = await resolveCurrentTarget(signal);
	if (refreshed.windowId <= 0 && !refreshed.nativeWindowRef) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}
	return refreshed;
}

interface CaptureResult {
	target: ResolvedTarget;
	capture: CurrentCapture;
	look: LookResponse;
	outline: Outline;
	activation: ActivationFlags;
}

function captureForLook(look: LookResponse): CurrentCapture {
	return {
		stateId: randomUUID(),
		width: look.image?.width ?? 0,
		height: look.image?.height ?? 0,
		scaleFactor: look.window.scaleFactor,
		timestamp: Date.now(),
	};
}

async function performLook(target: ResolvedTarget, options: { readText: "auto" | "always" | "never"; baseLookId?: string; scopeRef?: string; maxDimension?: number; includeImage?: boolean }, signal?: AbortSignal): Promise<LookResponse> {
	if ((!Number.isFinite(target.windowId) || target.windowId <= 0) && !target.nativeWindowRef) throw new Error(`Current platform requires a stable root id to observe '${target.windowTitle}'. Call find_roots and select a root with a stable id.`);
	return await currentPlatformBackend.observe({
		target: nativeWindowRequest(target),
		baseLookId: options.baseLookId,
		readText: options.readText,
		scopeRef: options.scopeRef,
		maxDimension: options.maxDimension,
		includeImage: options.includeImage,
	}, { signal, timeoutMs: LOOK_TIMEOUT_MS });
}

function noteWindowForTarget(target: ResolvedTarget | CurrentTarget, look?: LookResponse) {
	return {
		windowRef: target.windowRef,
		title: target.windowTitle,
		pairing: look?.window.metadata?.pairing && typeof look.window.metadata.pairing === "object" ? (look.window.metadata.pairing as { confidence?: "exact" | "high" | "low" }).confidence : undefined,
		pairingScore: look?.window.metadata?.pairing && typeof look.window.metadata.pairing === "object" ? (look.window.metadata.pairing as { score?: number }).score : undefined,
	};
}

async function captureCurrentTarget(signal?: AbortSignal, readText: "auto" | "always" | "never" = "auto", maxDimension = AUTO_IMAGE_MAX_DIMENSION, targetOverride?: ResolvedTarget, includeImage = true): Promise<CaptureResult> {
	const state = operationState();
	const baseOutline = state.currentOutline;
	const baseTarget = state.currentTarget;
	let target = targetOverride ?? await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const look = await performLook(target, { maxDimension, readText, includeImage }, signal);
	const outline = stabilizeRefs(baseTarget && sameRootIdentity(baseTarget, target) ? baseOutline : undefined, look.parsedOutline!);
	look.parsedOutline = outline;
	look.outline = outline.root;
	const capture = captureForLook(look);

	setCurrentTarget(target);
	state.currentCapture = capture;
	state.currentStateTarget = { pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	state.currentLook = look;
	state.currentOutline = outline;
	state.currentNote = noteFromLook(state.currentNote, outline, noteWindowForTarget(target, look));
	state.resourceKey = desktopResourceKey(target);
	// The broker owns the global epoch; a fresh observation adopts it so a write
	// from another agent between observe and act reads as stale, not as a merge.
	if (state.epoch === undefined) state.epoch = await resourceScheduler.syncEpoch(state.resourceKey);

	return {
		target,
		capture,
		look,
		outline,
		activation: emptyActivation(),
	};
}

async function buildToolResult(
	tool: string,
	summary: string,
	result: CaptureResult,
	execution: ExecutionTrace,
	_signal?: AbortSignal,
	imageMode: ImageMode = operationState().currentImageMode ?? "auto",
	base?: { stateId: string; outline: Outline },
): Promise<AgentToolResult<ComputerUseDetails>> {
	const state = operationState();
	const fallbackReason = imageFallbackReason(tool, result, imageMode);
	const transition = base ? changesBetween(base.outline, result.outline) : undefined;
	const useDiff = Boolean(transition && !transition.useFullView);
	const folded = foldToBudget(result.outline);
	const renderedNote = renderNote(state.currentNote);

	const details: ComputerUseDetails = {
		tool,
		target: {
			app: result.target.appName,
			bundleId: result.target.bundleId,
			pid: result.target.pid,
			windowTitle: result.target.windowTitle,
			windowId: result.target.windowId,
			windowRef: result.target.windowRef ?? state.currentTarget?.windowRef,
			nativeWindowRef: result.target.nativeWindowRef ?? state.currentTarget?.nativeWindowRef,
		},
		capture: {
			stateId: result.capture.stateId,
			width: result.capture.width,
			height: result.capture.height,
			scaleFactor: result.capture.scaleFactor,
			timestamp: result.capture.timestamp,
			coordinateSpace: "window-relative-screenshot-pixels",
		},
		lookId: result.look.lookId,
		view: useDiff ? "diff" : "full",
		baseStateId: transition ? base?.stateId : undefined,
		changes: useDiff ? transition?.changes : undefined,
		viewReason: transition?.useFullView ? transition.reason : undefined,
		renderedOutline: folded.text,
		outline: serializeOutline(result.outline),
		note: state.currentNote,
		activation: result.activation,
		execution,
		status: "ok",
		config: getComputerUseConfig(),
		helper: runtimeState.helperDiagnostics,
		imageReason: fallbackReason?.reason,
	};

	// Console piggyback: when a CDP connection is active for this browser
	// window, surface console output collected since the last tool result.
	let consoleText = "";
	if (currentPlatformBackend.isChromeFamilyApp(result.target.appName, result.target.bundleId)) {
		const tab = await cdpTabForWindow(result.target.windowTitle, result.target.framePoints);
		const entries = tab?.drainConsole() ?? [];
		if (entries.length > 0) {
			details.console = entries;
			consoleText = `\n\nBrowser console since the last action:\n${entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`;
		}
	}

	const noteText = renderedNote ? `\n\n${renderedNote}` : "";
	// The model must echo capture.stateId into follow-up tools. Exposing only the
	// helper-internal lookId here makes a plausible but invalid stateId easy to use.
	const renderedChanges = useDiff ? renderChanges(transition!.changes) : "";
	const outlineText = useDiff
		? `\n\nChanges (${transition!.changedNodeCount}, ${base!.stateId} → ${result.capture.stateId}):\n${renderedChanges || "(no element changes)"}\nUse stateId ${result.capture.stateId} for subsequent actions and queries.`
		: `\n\nOutline (${folded.nodeCount} nodes, stateId ${result.capture.stateId}${transition?.reason ? `, full view: ${transition.reason}` : ""}${folded.truncated ? ", folded output truncated" : ""}):\n${folded.text}`;
	const fallbackText = fallbackReason ? `\n\n${fallbackReason.message}` : "";
	const deltaText = rootDeltaLines(execution).join("\n");
	const content: AgentToolResult<ComputerUseDetails>["content"] = [{ type: "text", text: `${summary}${deltaText ? `\n${deltaText}` : ""}${consoleText}${noteText}${outlineText}${fallbackText}` }];
	if (fallbackReason && result.look.image?.jpegBase64) {
		content.push({ type: "image", data: result.look.image.jpegBase64, mimeType: result.look.image.mimeType ?? "image/jpeg" });
	}

	return { content, details };
}

type NativePreparedAction = Exclude<PreparedAction, { action: "wait" }>;

function currentLookOrThrow(): LookResponse {
	const state = operationState();
	if (!state.currentLook || !state.currentCapture) {
		throw new Error("No current look. Call observe_ui first, then act using refs or coordinates from that look.");
	}
	return state.currentLook;
}

function ensurePointIsInLookImage(x: number, y: number, look: LookResponse, errorPrefix = "Coordinates"): void {
	if (!look.image?.jpegBase64) {
		throw new Error(`${errorPrefix} require an image-bearing root. This look is outline-only; use an @e ref with a semantic action or observe an image-bearing root.`);
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${errorPrefix} must be finite numbers.`);
	}
	if (x < 0 || y < 0 || x >= look.image.width || y >= look.image.height) {
		throw new Error(`${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest look image bounds (${look.image.width}x${look.image.height}). Call observe_ui again and retry.`);
	}
}

function modelRefForRootDelta(delta: NonNullable<HelperActResult["rootDelta"]>[number]): string | undefined {
	if (!delta.ref) return undefined;
	if (delta.ref.startsWith("@r")) return delta.ref;
	for (const record of runtimeState.windowRefs.values()) {
		if (record.nativeWindowRef === delta.ref || record.ref === delta.ref) return record.ref;
	}
	const ref = `@r${runtimeState.nextRootRefIndex++}`;
	const current = operationState().currentTarget;
	const record: WindowRefRecord = {
		ref,
		appName: current?.pid === delta.pid ? current.appName : "Unknown App",
		bundleId: current?.pid === delta.pid ? current.bundleId : undefined,
		pid: delta.pid,
		windowTitle: delta.title ?? "(untitled)",
		nativeWindowRef: delta.ref,
		framePoints: { x: 0, y: 0, w: 1, h: 1 },
		scaleFactor: 1,
		isMinimized: false,
		isOnscreen: true,
		isMain: false,
		isFocused: delta.change === "focused",
	};
	runtimeState.windowRefs.set(ref, record);
	runtimeState.windowRefByIdentity.set(windowRecordIdentity(record), ref);
	return ref;
}

/** Translate native delivery into the level a user cares about. */
function deliveryLevelOf(performed: HelperActPerformed | undefined, policy: DeliveryPolicy): "L1" | "L2" | "L4" | undefined {
	const delivery = performed?.delivery;
	if (delivery === "ax") return "L1";
	if (delivery === "l2" || delivery === "pid") return "L2";
	if (delivery === "hid") return "L4";
	return policy === "foreground" ? "L4" : undefined;
}

function executionTraceFromAct(result: HelperActResult, policy = currentDeliveryPolicy()): ExecutionTrace {
	const rootDelta = result.rootDelta?.map((delta) => ({ ...delta, ref: modelRefForRootDelta(delta) }));
	return executionTrace("act", result.performed?.delivery === "ax" ? "stealth" : "default", {
		outcome: result.outcome,
		performed: result.performed,
		evidence: result.evidence,
		error: result.error,
		stoppedAt: result.stoppedAt,
		rootDelta,
		delivery: result.performed?.delivery,
		deliveryPolicy: policy,
		deliveryLevel: deliveryLevelOf(result.performed, policy),
		interferedWithUser: result.performed?.interferedWithUser === true ? true : undefined,
		stoppedByUser: computerUseStopRequested() ? true : undefined,
	});
}

async function helperAct(
	target: ResolvedTarget,
	action: NativePreparedAction,
	headless: boolean,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const checked = (candidate: HelperActResult): HelperActResult => {
		if (!candidate || !["worked", "didnt", "unknown"].includes(candidate.outcome)) {
			throw new Error("Helper act returned an invalid result without an outcome.");
		}
		return candidate;
	};
	const textTimeout = "text" in action.params ? action.params.text.length * 25 + 4_000 : COMMAND_TIMEOUT_MS;
	const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, textTimeout);
	if ((action.usesCurrentFocus || action.needsForeground) && !headless) {
		const foreground = checked(await currentPlatformBackend.act(helperActRequest(target, action, "foreground"), { signal, timeoutMs }));
		const trace = executionTraceFromAct(foreground, "foreground");
		trace.backgroundFirst = false;
		return trace;
	}
	try {
		const initialPolicy = headless ? currentDeliveryPolicy() : "background";
		const result = checked(await currentPlatformBackend.act(helperActRequest(target, action, initialPolicy), { signal, timeoutMs }));
		if (canRetryInForeground(action, result.outcome, headless)) {
			const foreground = checked(await currentPlatformBackend.act(helperActRequest(target, action, "foreground"), { signal, timeoutMs }));
			const trace = executionTraceFromAct(foreground, "foreground");
			trace.backgroundFirst = true;
			trace.escalatedToForeground = true;
			trace.escalationReason = "side_effect_free_didnt";
			trace.backgroundAttempt = { outcome: "didnt", reason: "Background input produced no observable value change; a foreground retry was safe." };
			return trace;
		}
		const trace = executionTraceFromAct(result, "background");
		trace.backgroundFirst = true;
		return trace;
	} catch (error) {
		const code = (error as Error & { code?: string })?.code;
		if (code !== "foreground_required" || headless) throw error;
		const foreground = checked(await currentPlatformBackend.act(helperActRequest(target, action, "foreground"), { signal, timeoutMs }));
		const trace = executionTraceFromAct(foreground, "foreground");
		trace.backgroundFirst = true;
		trace.escalatedToForeground = true;
		trace.escalationReason = code;
		trace.backgroundAttempt = { outcome: "foreground_required", reason: error instanceof Error ? error.message : String(error) };
		return trace;
	}
}

function helperActRequest(target: ResolvedTarget, action: NativePreparedAction, policy = currentDeliveryPolicy()): PlatformActRequest {
	const look = currentLookOrThrow();
	const delivery = nativeInputDelivery(policy, target);
	const base = { lookId: look.lookId, pid: target.pid, target: action.target, policy };
	return (() => {
		switch (action.action) {
			case "press":
			case "click": return { ...base, action: action.action, params: { ...action.params, delivery } };
			case "setText": return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "typeText": return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "keypress": return { ...base, action: action.action, params: { keys: action.params.keys, delivery } };
			case "scroll": return { ...base, action: action.action, params: { scrollX: action.params.scrollX, scrollY: action.params.scrollY, delivery } };
			case "drag": return { ...base, action: action.action, params: { path: action.params.path, delivery } };
			case "moveMouse": return { ...base, action: action.action, params: { delivery } };
			case "hover": return { ...base, action: action.action, params: { delivery } };
			case "select":
				return { ...base, action: "select", params: { ...(typeof action.params.option === "string" ? { option: action.params.option } : {}), delivery } };
			case "setChecked":
				return { ...base, action: "setChecked", params: { checked: action.params.checked === true, delivery } };
			case "setValue":
				return { ...base, action: "setValue", params: { value: Number(action.params.value), delivery } };
			case "expand":
			case "collapse":
			case "scrollTo":
			case "focus":
			case "clear":
			case "showMenu":
				return { ...base, action: action.action, params: { delivery } };
		}
	})();
}

function rootDeltaLines(execution: ExecutionTrace): string[] {
	return (execution.rootDelta ?? []).map((delta) => {
		const quotedTitle = delta.title ? ` ${JSON.stringify(delta.title)}` : "";
		const ref = delta.ref ? ` (${delta.ref.startsWith("@") ? delta.ref : `@${delta.ref}`})` : "";
		const sheetCount = typeof delta.metadata?.sheetCount === "number" && Number.isFinite(delta.metadata.sheetCount) ? Math.max(0, Math.trunc(delta.metadata.sheetCount)) : undefined;
		const flags = [delta.isModal ? "modal" : undefined, sheetCount ? `sheets=${sheetCount}` : undefined].filter(Boolean).join(", ");
		const suffix = `${quotedTitle}${flags ? ` (${flags})` : ""}${ref}`;
		if (delta.change === "appeared") return `New root: ${delta.kind}${suffix}`;
		if (delta.change === "closed") return `Root closed: ${delta.kind}${suffix}`;
		return `Root focused: ${delta.kind}${suffix}`;
	});
}

function windowDetails(app: HelperApp, window: HelperWindow, config: ReturnType<typeof getComputerUseConfig>): ListWindowsDetails["windows"][number] {
	const storedRef = storeWindowRefForAppWindow(app, window);
	return {
		app: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		kind: window.kind,
		windowTitle: window.title || "(untitled)",
		windowId: window.windowId,
		windowRef: storedRef.ref,
		nativeWindowRef: window.windowRef,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
		isModal: window.isModal,
		sheetCount: platformRootSheetCount(window),
		role: window.role,
		subrole: window.subrole,
		pairing: platformRootPairing(window),
		zOrder: window.zOrder,
		browserUseAllowed: config.browser_use || !currentPlatformBackend.isBrowserApp(app.appName, app.bundleId),
		score: scoreWindow(window),
	};
}

function sortWindowDetails(windows: ListWindowsDetails["windows"]): ListWindowsDetails["windows"] {
	return windows.sort((a, b) => b.score - a.score || a.app.localeCompare(b.app) || a.windowTitle.localeCompare(b.windowTitle));
}

// Side effect: stores stable @r refs for discovered windows in runtimeState.
async function collectWindowDetails(apps: HelperApp[], config: ReturnType<typeof getComputerUseConfig>, signal?: AbortSignal): Promise<ListWindowsDetails["windows"]> {
	const perApp = await Promise.all(apps.map(async (app) => ({ app, windows: await listWindows(app.pid, signal) })));
	return sortWindowDetails(perApp.flatMap(({ app, windows }) => windows.map((window) => windowDetails(app, window, config))));
}

function collectBroadWindowDetails(roots: HelperWindow[], config: ReturnType<typeof getComputerUseConfig>): ListWindowsDetails["windows"] {
	const windows: ListWindowsDetails["windows"] = [];
	for (const window of roots) {
		if (!window.pid) continue;
		windows.push(windowDetails({ appName: window.appName ?? "Unknown App", bundleId: window.bundleId, pid: window.pid }, window, config));
	}
	return sortWindowDetails(windows);
}

async function windowDetailsForFind(query: FindParams, config: ReturnType<typeof getComputerUseConfig>, signal?: AbortSignal): Promise<ListWindowsDetails["windows"]> {
	const host = await hostApplication(signal);
	if (!query.app && !query.bundleId && !Number.isFinite(query.pid)) {
		const roots = excludeHostRoots(await currentPlatformBackend.listRoots({}, signal), host);
		return collectBroadWindowDetails(roots, config);
	}
	// The host terminal/IDE is never offered as a root, even when asked for by name.
	const apps = (await listApps(signal))
		.filter((app) => appMatchesWindowQuery(app, query))
		.filter((app) => !host || app.pid !== host.pid);
	return await collectWindowDetails(apps, config, signal);
}

async function performListWindows(params: FindParams, signal?: AbortSignal): Promise<AgentToolResult<ListWindowsDetails>> {
	const rawParams = params ?? {};
	const query: FindParams = {
		text: trimOrUndefined(rawParams.text),
		app: trimOrUndefined(rawParams.app),
		bundleId: trimOrUndefined(rawParams.bundleId),
		pid: Number.isFinite(rawParams.pid) ? Math.trunc(rawParams.pid!) : undefined,
		kind: rawParams.kind,
	};
	const config = getComputerUseConfig();
	const desktopForest = await windowDetailsForFind(query, config, signal);
	const includeBrowserPages = !query.pid && !query.bundleId && (!query.app || normalizeText(query.app) === "browser") && config.browser_use;
	const browserForest: ListWindowsDetails["windows"] = !includeBrowserPages ? [] : (await listCdpPageContexts().catch(() => []))
		.map((page) => ({
			app: "Browser",
			pid: 0,
			kind: "browser_page",
			windowTitle: page.title || page.url,
			windowRef: storeBrowserRootRef(page.contextId),
			framePoints: { x: 0, y: 0, w: 1, h: 1 },
			scaleFactor: 1,
			isMinimized: false,
			isOnscreen: true,
			isMain: false,
			isFocused: false,
			isModal: false,
			zOrder: Number.MAX_SAFE_INTEGER,
			browserUseAllowed: true,
			score: 0,
			url: page.url,
		}));
	const allRoots = [...desktopForest, ...browserForest];
	const forest = allRoots.filter((root) => !query.kind || root.kind === query.kind);
	const ranked = forest.map((root, order) => ({ root, order, match: query.text ? rankedTextMatch([root.app, root.windowTitle], query.text) : { reason: "filter" as const, score: 1 } }))
		.filter((entry) => entry.match)
		.sort((a, b) => b.match!.score - a.match!.score || Number(b.root.isFocused) - Number(a.root.isFocused) || a.root.zOrder - b.root.zOrder || a.order - b.order);
	const totalMatches = ranked.length;
	const windows = ranked.slice(0, 12).map((entry) => entry.root);
	const details: ListWindowsDetails = { tool: "find_roots", query, windows, totalMatches, returned: windows.length, hasMore: totalMatches > windows.length, config };
	const lines = windows.map(formatWindowLine);
	const text = lines.length
		? `Found ${totalMatches} matching root${totalMatches === 1 ? "" : "s"}; returned ${windows.length}${totalMatches > windows.length ? ". Refine the filters for additional roots" : ""}. Use @r refs with observe_ui({ root: "@rN" }).\n${lines.join("\n")}`
		: query.text || query.app || query.bundleId || query.pid || query.kind
			? "No roots matched the supplied filters."
			: "No roots are currently visible to pi-computer-use.";
	return { content: [{ type: "text", text }], details };
}

function normalizeImageMode(value: unknown): ImageMode {
	return value === "always" || value === "never" ? value : "auto";
}

function isBrowserContextId(contextId: string | undefined): contextId is string {
	return Boolean(contextId?.startsWith(BROWSER_CONTEXT_PREFIX));
}

function browserSnapshotTarget(snapshotId: string | undefined, ref: string | undefined): { contextId: string; backendNodeId?: number } | undefined {
	if (!snapshotId || !ref) return undefined;
	const record = savedStates.get(snapshotId);
	const snapshot = record?.value.kind === "browser" ? record.value.snapshot : undefined;
	const target = snapshot?.targets.find((candidate) => candidate.ref === ref);
	if (!snapshot || !target) return undefined;
	return { contextId: snapshot.contextId, backendNodeId: target.backendNodeId };
}

function browserContextForOperation(): string | undefined {
	const contextId = operationState().contextId;
	return isBrowserContextId(contextId) ? contextId : undefined;
}

async function withBrowserWrite<T>(contextId: string, work: () => Promise<T>, lease?: LeaseContext): Promise<T> {
	const state = operationState();
	const targetId = contextId.slice(BROWSER_CONTEXT_PREFIX.length);
	const resourceKey = `cdp:${targetId}`;
	const baseEpoch = state.epoch ?? await resourceScheduler.syncEpoch(resourceKey);
	const result = await resourceScheduler.write(resourceKey, baseEpoch, async (nextEpoch) => {
		state.resourceKey = resourceKey;
		state.epoch = nextEpoch;
		return await work();
	}, { action: lease?.action });
	return result.value;
}

function browserObservationResult(browser: CdpPageSnapshot, resourceKey: string, epoch: number, tool: string, base?: { stateId: string; outline: SerializedOutline }): AgentToolResult<BrowserObservationDetails> {
	savedStates.set({ stateId: browser.snapshotId, resourceKey, epoch, value: { kind: "browser", snapshot: browser, outline: browser.outline } });
	const currentOutline = restoreOutline(browser.outline);
	const transition = base ? changesBetween(restoreOutline(base.outline), currentOutline) : undefined;
	const useDiff = Boolean(transition && !transition.useFullView);
	const folded = foldToBudget(currentOutline);
	const root = { ref: storeBrowserRootRef(browser.contextId), kind: "browser_page" as const, title: browser.title, url: browser.url };
	const details: BrowserObservationDetails = { tool, kind: "browser_page", stateId: browser.snapshotId, baseStateId: base?.stateId, view: useDiff ? "diff" : "full", changes: useDiff ? transition?.changes : undefined, root, outline: browser.outline, renderedOutline: folded.text };
	const viewText = useDiff
		? `Changes (${transition!.changedNodeCount}, ${base!.stateId} → ${browser.snapshotId}):\n${renderChanges(transition!.changes) || "(no element changes)"}\nUse stateId ${browser.snapshotId} for subsequent actions and queries.`
		: folded.text;
	return { content: [{ type: "text", text: `${tool} completed for ${root.ref} ${JSON.stringify(browser.title)}. State ${browser.snapshotId}.\n${viewText}` }], details };
}

async function refreshBrowserSnapshot(contextId: string, tool: string, base?: { stateId: string; outline: SerializedOutline }): Promise<AgentToolResult<BrowserObservationDetails>> {
	const browser = await cdpSnapshotForContext(contextId);
	if (!browser) throw new Error(`Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`);
	const state = operationState();
	const resourceKey = state.resourceKey ?? `cdp:${browser.targetId}`;
	return browserObservationResult(browser, resourceKey, state.epoch ?? resourceScheduler.epoch(resourceKey), tool, base);
}

function sliceText(value: string, offsetValue: unknown, _limitValue?: unknown): Pick<ReadTextDetails, "offset" | "limit" | "totalChars" | "hasMore" | "text"> {
	const offset = Math.max(0, Math.trunc(toFiniteNumber(offsetValue, 0)));
	const limit = UI_TEXT_PAGE_CHARS;
	const characters = Array.from(value);
	const end = Math.min(characters.length, offset + limit);
	return {
		offset,
		limit,
		totalChars: characters.length,
		hasMore: end < characters.length,
		text: offset >= characters.length ? "" : characters.slice(offset, end).join(""),
	};
}

async function performReadText(params: ReadTextParams, signal?: AbortSignal): Promise<AgentToolResult<ReadTextDetails>> {
	const ref = trimOrUndefined(params.ref);
	if (ref?.startsWith("@o")) {
		const page = readStoredOutput(ref, params.offset);
		if (!page) throw new Error(`Output ref '${ref}' is unavailable or was evicted. Rerun the focused query.`);
		const details: ReadTextDetails = { tool: "read_text", ref, ...page };
		const suffix = page.hasMore
			? `\n\ncontinue: read_text({ ref: "${ref}", offset: ${page.offset + page.limit} })`
			: page.complete ? "" : "\n\ncontinuation storage limit reached; rerun a more focused query for the remainder";
		return { content: [{ type: "text", text: `${page.text || "(empty output page)"}${suffix}` }], details };
	}
	const contextId = operationState().contextId;
	if (isBrowserContextId(contextId)) {
		const snapshot = operationState().browserSnapshot;
		if (!snapshot || snapshot.contextId !== contextId) throw new Error(`Browser state '${params.stateId}' is unavailable. Observe the browser root again.`);
		if (!ref) throw new Error("read_text requires an @e ref for browser contexts; use the outline root ref for whole-page text.");
		const outline = restoreOutline(snapshot.outline);
		const node = nodeByRef(outline, ref);
		if (!node) throw new Error(`Browser text ref '${ref}' is unavailable in this state.`);
		const collect = (current: OutlineNode): string[] => [outlineNodeLabel(current), ...current.text.map((item) => item.string), ...current.children.flatMap(collect)].filter(Boolean);
		const value = node === outline.root ? snapshot.text : [...new Set(collect(node))].join("\n");
		const sliced = sliceText(value, params.offset);
		const details: ReadTextDetails = { tool: "read_text", ref, ...sliced };
		return { content: [{ type: "text", text: sliced.text || "(empty text slice)" }], details };
	}

	validateStateId(params.stateId);
	if (!ref) throw new Error("read_text requires ref for desktop contexts. Call observe_ui/inspect_ui and use a text-bearing outline ref.");
	const node = outlineNodeByRef(ref);
	const state = operationState();
	if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
	const raw = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await currentPlatformBackend.readText({
		lookId: state.currentOutline!.lookId,
		elementRef: wireRefForNode(node),
		offset: Math.max(0, Math.trunc(toFiniteNumber(params.offset, 0))),
		limit: UI_TEXT_PAGE_CHARS,
	}, { signal, timeoutMs: COMMAND_TIMEOUT_MS }))).value;
	const text = raw.text;
	const details: ReadTextDetails = {
		tool: "read_text",
		ref,
		offset: raw.offset,
		limit: raw.limit,
		totalChars: raw.totalChars,
		hasMore: raw.hasMore,
		text,
	};
	return { content: [{ type: "text", text: text || "(empty text slice)" }], details };
}

function normalizeWaitTimeoutMs(value: unknown): number {
	return Math.max(100, Math.min(60_000, Math.trunc(toFiniteNumber(value, 10_000))));
}

function conditionScopeRef(params: WaitForParams | NonNullable<ActParams["expect"]>): string | undefined {
	const ref = trimOrUndefined(params.ref);
	const scopeRef = trimOrUndefined(params.scopeRef);
	if (ref && scopeRef) throw new Error("A UI condition accepts ref or scopeRef, not both.");
	return ref ?? scopeRef;
}

function validateCondition(params: WaitForParams | NonNullable<ActParams["expect"]>): { text?: string; role?: string; value?: string; scopeRef?: string; scopeExact: boolean; gone: boolean; timeoutMs: number } {
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const value = trimOrUndefined(params.value);
	const scopeRef = conditionScopeRef(params);
	if (!text && !role && !value) throw new Error("A UI condition requires text, role, or value.");
	if (role && !text && !value && !scopeRef) throw new Error("A role-only UI condition requires ref or scopeRef.");
	if (value && !params.ref) throw new Error("A value UI condition requires an exact ref.");
	return { text, role, value, scopeRef, scopeExact: Boolean(params.ref), gone: params.until === "absent", timeoutMs: normalizeWaitTimeoutMs(params.timeoutMs) };
}

function nodeWithinScope(node: OutlineNode, scopeRef: string | undefined, scopeExact: boolean): boolean {
	if (!scopeRef) return true;
	if (scopeExact) return node.ref === scopeRef;
	let current: OutlineNode | undefined = node;
	while (current) {
		if (current.ref === scopeRef) return true;
		current = current.parent;
	}
	return false;
}

function normalizedRole(value: string): string {
	return value.toLowerCase().replace(/^ax/, "").replace(/[ _-]+/g, "");
}

function platformRole(outline: Outline, role: string | undefined): string | undefined {
	if (!role) return undefined;
	return outline.nodes.find((node) => normalizedRole(node.role) === normalizedRole(role))?.role ?? role;
}

function outlineConditionPresent(outline: Outline, condition: ReturnType<typeof validateCondition>): boolean {
	return searchOutline(outline, condition.text, undefined, undefined, outline.nodes.length)
		.some((match) => (!condition.role || normalizedRole(match.node.role) === normalizedRole(condition.role)) && nodeWithinScope(match.node, condition.scopeRef, condition.scopeExact) && (!condition.value || normalizeText(match.node.value) === normalizeText(condition.value)));
}

function conditionScopeNode(outline: Outline, condition: ReturnType<typeof validateCondition>): OutlineNode | undefined {
	const scopeNode = condition.scopeRef ? nodeByRef(outline, condition.scopeRef) : undefined;
	if (condition.scopeRef && !scopeNode) throw new Error(`Condition scope ref '${condition.scopeRef}' is unavailable in this state.`);
	return scopeNode;
}

async function performWaitFor(params: WaitForParams, signal?: AbortSignal): Promise<AgentToolResult<WaitForDetails>> {
	const contextId = operationState().contextId;
	const condition = validateCondition(params);
	const { text, role, value, scopeRef, scopeExact, gone, timeoutMs } = condition;

	if (isBrowserContextId(contextId)) {
		const state = operationState();
		if (!state.resourceKey) throw new Error("The browser observation has no live resource identity. Observe again.");
		const baseSnapshot = state.browserSnapshot;
		if (!baseSnapshot) throw new Error("Browser wait requires a complete base observation.");
		conditionScopeNode(restoreOutline(baseSnapshot.outline), condition);
		const deadline = Date.now() + timeoutMs;
		let lastSnapshot: CdpPageSnapshot | undefined;
		let lastEpoch = state.epoch ?? resourceScheduler.epoch(state.resourceKey);
		const finish = (found: boolean, timedOut?: boolean): AgentToolResult<WaitForDetails> => {
			if (!lastSnapshot) throw new Error("Browser wait completed without an observation.");
			savedStates.set({ stateId: lastSnapshot.snapshotId, resourceKey: state.resourceKey!, epoch: lastEpoch, value: { kind: "browser", snapshot: lastSnapshot, outline: lastSnapshot.outline } });
			const successorOutline = restoreOutline(lastSnapshot.outline);
			const transition = changesBetween(restoreOutline(baseSnapshot.outline), successorOutline);
			const useDiff = !transition.useFullView;
			const renderedOutline = foldToBudget(successorOutline).text;
			const details: WaitForDetails = { tool: "wait_for", stateId: lastSnapshot.snapshotId, baseStateId: baseSnapshot.snapshotId, view: useDiff ? "diff" : "full", changes: useDiff ? transition.changes : undefined, found, gone: found && gone || undefined, timedOut, nodeCount: lastSnapshot.targets.length, text, role, value, scopeRef, outline: lastSnapshot.outline, renderedOutline };
			const message = found ? (gone ? "Condition disappeared." : "Condition appeared.") : `Timed out after ${timeoutMs}ms waiting for condition.`;
			const viewText = useDiff ? `${renderChanges(transition.changes) || "(no element changes)"}\nUse stateId ${lastSnapshot.snapshotId} for subsequent actions and queries.` : renderedOutline;
			return { content: [{ type: "text", text: `${message}\n${viewText}` }], details };
		};
		do {
			const scheduled = await resourceScheduler.read(state.resourceKey, async () => await cdpSnapshotForContext(contextId));
			lastSnapshot = scheduled.value;
			lastEpoch = scheduled.epoch;
			if (!lastSnapshot) throw new Error(`Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`);
			const present = outlineConditionPresent(restoreOutline(lastSnapshot.outline), condition);
			if (present !== gone) return finish(true);
			await sleep(200, signal);
		} while (Date.now() < deadline);
		return finish(false, true);
	}

	const state = operationState();
	const baseView = { stateId: state.currentCapture!.stateId, outline: state.currentOutline! };
	let target = await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const scopeNode = conditionScopeNode(state.currentOutline!, condition);
	const raw = await currentPlatformBackend.waitFor({
		...nativeWindowRequest(target),
		lookId: state.currentOutline!.lookId,
		text,
		role: platformRole(state.currentOutline!, role),
		value,
		scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
		scopeExact,
		gone,
		timeoutMs,
	}, { signal, timeoutMs: timeoutMs + 2_000 });
	if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
	const refreshed = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await captureCurrentTarget(signal, "auto"))).value;
	const transition = changesBetween(baseView.outline, refreshed.outline);
	const useDiff = !transition.useFullView;
	const matches = searchOutline(refreshed.outline, text, role, undefined, 1);
	const foundTarget = matches[0];
	const details: WaitForDetails = {
		tool: "wait_for",
		stateId: refreshed.capture.stateId,
		baseStateId: baseView.stateId,
		view: useDiff ? "diff" : "full",
		changes: useDiff ? transition.changes : undefined,
		found: raw.found,
		gone: raw.gone || undefined,
		timedOut: raw.timedOut || undefined,
		target: foundTarget ? serializeOutlineSearchMatch(foundTarget) : undefined,
		nodeCount: Number.isFinite(raw.nodeCount) ? Number(raw.nodeCount) : refreshed.outline.nodes.length,
		text,
		role,
		value,
		scopeRef,
		outline: serializeOutline(refreshed.outline),
		renderedOutline: foldToBudget(refreshed.outline).text,
	};
	const message = details.found ? (details.gone ? "Condition disappeared." : "Condition appeared.") : `Timed out after ${timeoutMs}ms waiting for condition.`;
	const viewText = useDiff ? `${renderChanges(transition.changes) || "(no element changes)"}\nUse stateId ${refreshed.capture.stateId} for subsequent actions and queries.` : details.renderedOutline;
	return { content: [{ type: "text", text: `${message}\n${viewText}` }], details };
}

function sameRootIdentity(a: CurrentTarget, b: CurrentTarget): boolean {
	if (a.pid !== b.pid) return false;
	if (a.windowId > 0 && b.windowId > 0) return a.windowId === b.windowId;
	if (a.nativeWindowRef && b.nativeWindowRef) return a.nativeWindowRef === b.nativeWindowRef;
	return normalizeText(a.windowTitle) === normalizeText(b.windowTitle);
}

/** Side effects: captures/updates current target, capture state, look, and parsed outline. */
async function performObserve(params: ObserveParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | BrowserObservationDetails>> {
	const requestedRoot = typeof params.root === "string" ? params.root : undefined;
	if (requestedRoot && !/^@r\d+$/.test(requestedRoot)) throw new Error("observe_ui.root must be an exact @r ref issued by find_roots.");
	const browserContextId = requestedRoot ? runtimeState.browserContextByRoot.get(requestedRoot) : undefined;
	if (isBrowserContextId(browserContextId)) {
		const targetId = browserContextId.slice(BROWSER_CONTEXT_PREFIX.length);
		const resourceKey = `cdp:${targetId}`;
		const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(browserContextId));
		const browser = scheduled.value;
		if (!browser) throw new Error(`Browser context '${browserContextId}' is no longer available. Call find_roots again.`);
		return browserObservationResult(browser, resourceKey, await resourceScheduler.syncEpoch(resourceKey), "observe_ui");
	}
	const state = operationState();
	const mode = params.mode ?? "fused";
	const image = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
	const defaultReadText = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
	const readText = params.readText ?? defaultReadText;
	state.currentImageMode = normalizeImageMode(image);
	const selection: ObserveTargetParams = { root: normalizeWindowSelector(params.root) };
	const requestedTarget = selection.root
		? await resolveTargetByWindowSelector(params.root!, signal)
		: await resolveTargetForObserve(signal);
	const imageMode = normalizeImageMode(image);
	const resourceKey = desktopResourceKey(requestedTarget);
	const scheduled = await resourceScheduler.read(resourceKey, async (epoch) => {
		state.resourceKey = resourceKey;
		state.epoch = epoch;
		return await captureCurrentTarget(signal, readText, imageMode === "always" ? EXPLICIT_IMAGE_MAX_DIMENSION : AUTO_IMAGE_MAX_DIMENSION, requestedTarget, imageMode !== "never");
	});
	const captureResult = scheduled.value;
	// Model @r refs are re-minted on re-resolution, so ref string equality
	// alone false-positives as drift for the same root; compare stable
	// identity against the resolved request too.
	if (!matchesObserveSelection(captureResult.target, selection) && !sameRootIdentity(captureResult.target, requestedTarget)) {
		throw new Error(
			`Observation target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call observe_ui again or specify a more exact window title.`,
		);
	}
	const summary = `Observed ${mode} ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`;
	return await buildToolResult("observe_ui", summary, captureResult, executionTrace("look", "stealth"), signal, imageMode);
}

function currentOutlineOrThrow(stateId?: string): Outline {
	validateStateId(stateId);
	const outline = operationState().currentOutline;
	if (!outline) throw new Error("No observation outline is available. Call observe_ui first.");
	return outline;
}

function matchIsNonActionableStatic(match: OutlineSearchMatch): boolean {
	const node = match.node;
	return !node.canPress && !node.canFocus && !node.canSetValue && node.actions.length === 0 && !node.pictureOnly;
}

function shouldEscalateSearchOCR(matches: OutlineSearchMatch[], _text?: string): boolean {
	return matches.length === 0 || matches.every(matchIsNonActionableStatic);
}

/** Pure outline query unless a window selector is supplied, in which case current target selection may change. */
async function performSearchUi(params: SearchUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	let outline = currentOutlineOrThrow(params.stateId);
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const capability = trimOrUndefined(params.capability);
	if (!text && !role && !capability) throw new Error("search_ui requires text, role, or capability. Use observe_ui for a bounded overview.");
	const limit = 12;
	let ranked = searchOutlineRanked(outline, text, role, capability, limit);
	let matches = ranked.matches;
	let escalatedOCR = false;
	const look = state.currentLook;
	if (shouldEscalateSearchOCR(matches, text) && look && look.readText?.requested !== "never" && !look.readText?.executed && state.lastSearchOcrEscalatedLookId !== look.lookId) {
		state.lastSearchOcrEscalatedLookId = look.lookId;
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		// captureCurrentTarget adopts the new look/outline/capture into
		// runtimeState, so refs in these matches stay actable. Keep the image
		// payload: OCR-only matches are clicked by coordinate, and coordinate
		// acts require the current look to be image-bearing.
		if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
		const captureResult = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await captureCurrentTarget(signal, "always", AUTO_IMAGE_MAX_DIMENSION, currentTarget))).value;
		outline = captureResult.outline;
		ranked = searchOutlineRanked(outline, text, role, capability, limit);
		matches = ranked.matches;
		escalatedOCR = true;
	}
	const detailMatches = matches.map(serializeOutlineSearchMatch);
	const details: OutlineToolDetails = { tool: "search_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, matches: detailMatches, totalMatches: ranked.totalMatches, returned: matches.length, hasMore: ranked.totalMatches > matches.length, note: state.currentNote };
	const lines = matches.map((match) => `${match.ref} ${match.role || "Unknown"} ${JSON.stringify(match.label || "(unlabeled)")} [${match.matchReason}${match.matchReason === "fuzzy" ? ` ${match.score?.toFixed(2)}` : ""}]\n  path: ${match.path}`);
	const noteHeader = renderNote(state.currentNote);
	const noteText = noteHeader ? `${noteHeader}\n\n` : "";
	const escalationText = escalatedOCR ? " OCR text was escalated for this search after the cached outline had no matches." : "";
	const moreText = ranked.totalMatches > matches.length ? ` Refine the query to inspect ${ranked.totalMatches - matches.length} additional matches.` : "";
	return { content: [{ type: "text", text: `${noteText}Found ${ranked.totalMatches} outline match${ranked.totalMatches === 1 ? "" : "es"}; returned ${matches.length}.${moreText}${escalationText}\n${lines.join("\n")}` }], details };
}

/** Reads cached outline; truncated refs trigger a scoped look. */
async function performExpandUi(params: ExpandUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	let outline = currentOutlineOrThrow(params.stateId);
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("expand_ui.ref is required.");
	const initialTarget = nodeByRef(outline, ref);
	if (!initialTarget) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	let target: OutlineNode = initialTarget;
	const depth = Math.max(1, Math.min(8, Math.trunc(toFiniteNumber(params.depth, 3))));
	const regionKey = noteRegionKeyForRef(outline, ref);
	const regionChanged = Boolean(regionKey && state.currentNote?.regions.some((region) => region.key === regionKey && region.status === "changed"));
	if (target.truncated || regionChanged) {
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		const targetWireRef = wireRefForNode(target);
		if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
		const scoped = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await performLook(currentTarget, {
			readText: "auto",
			baseLookId: outline.lookId,
			scopeRef: targetWireRef,
			maxDimension: 1,
			includeImage: false,
		}, signal))).value;
		target = graftScopedOutline(outline, target.ref, scoped.parsedOutline!);
		outline.lookId = scoped.lookId;
		state.currentOutline = outline;
		state.currentLook = { ...scoped, image: state.currentLook?.image, outline: outline.root, parsedOutline: outline };
		persistOperation(state);
	}
	const folded = foldToBudget(outline, { maxDepth: depth, maxNodes: 150 }, [target.ref]);
	const details: OutlineToolDetails = { tool: "expand_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, target: serializeOutlineNodeShallow(target), renderedOutline: folded.text, note: state.currentNote };
	return { content: [{ type: "text", text: `${formatOutlineNodeLabel(target)}\npath: ${outlineNodePath(target)}\n\n${folded.text}` }], details };
}

/** Pure cached-outline inspection. */
async function performInspectUi(params: InspectUiParams): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	const outline = currentOutlineOrThrow(params.stateId);
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("inspect_ui.ref is required.");
	const target = nodeByRef(outline, ref);
	if (!target) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	const details: OutlineToolDetails = { tool: "inspect_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, target: serializeOutlineNodeShallow(target), note: state.currentNote };
	const fields = [
		formatOutlineNodeLabel(target),
		`path: ${outlineNodePath(target)}`,
		`rect: ${JSON.stringify(target.rect)}`,
		`actions: ${target.actions.join(",") || "none"}`,
		`capabilities: ${[
			target.canPress ? "press" : undefined,
			target.canFocus ? "focus" : undefined,
			target.canSetValue ? "setValue" : undefined,
			target.canScroll ? "scroll" : undefined,
			target.canIncrement ? "increment" : undefined,
			target.canDecrement ? "decrement" : undefined,
			target.isTextInput ? "textInput" : undefined,
		].filter(Boolean).join(",") || "none"}`,
		`annotations: ${[
			target.offscreen ? "offscreen" : undefined,
			target.pictureOnly ? "pictureOnly" : undefined,
			target.truncated ? "truncated" : undefined,
			target.scrollExtent ? `scrollable ${target.scrollExtent.seen}/${target.scrollExtent.total}` : undefined,
		].filter(Boolean).join(",") || "none"}`,
	];
	return { content: [{ type: "text", text: fields.join("\n") }], details };
}

function prepareUiAction(action: UiAction, state: ActionState, look: LookResponse, headless: boolean): PreparedAction {
	return prepareAction(action, state, {
		headless,
		image: look.image,
		node: outlineNodeByRef,
		center: outlineNodeCenter,
		validatePoint: (x, y, label) => ensurePointIsInLookImage(x, y, look, label),
	});
}

async function dispatchUiAction(action: UiAction, target: ResolvedTarget, look: LookResponse, headless: boolean, state: ActionState, signal?: AbortSignal): Promise<ExecutionTrace> {
	const prepared = prepareUiAction(action, state, look, headless);
	if (prepared.action === "wait") {
		await sleep(prepared.params.ms, signal);
		return executionTrace("wait", "stealth", { outcome: "worked" });
	}
	const trace = await helperAct(target, prepared, headless, signal);
	if (!headless && (prepared.establishesFocus || (prepared.action === "click" && "x" in prepared.target))) {
		state.currentFocus = true;
	}
	return trace;
}

async function dispatchUiTransaction(actions: UiAction[], target: ResolvedTarget, look: LookResponse, headless: boolean, signal?: AbortSignal): Promise<ExecutionTrace> {
	// Strict-headless batches have one immutable delivery class. When foreground
	// fallback is permitted, decide independently per action so a completed
	// background prefix is never replayed as part of a foreground batch.
	if (headless && currentPlatformBackend.actBatch) {
		const actionState: ActionState = { currentFocus: false };
		const policy = currentDeliveryPolicy();
		const requests = actions.map((action) => helperActRequest(target, prepareUiAction(action, actionState, look, true) as NativePreparedAction, policy));
		const textLength = actions.reduce((sum, action) => sum + (action.text?.length ?? 0), 0);
		const result = await currentPlatformBackend.actBatch(requests, { signal, timeoutMs: Math.max(COMMAND_TIMEOUT_MS, textLength * 25 + 6_000) });
		if (!result.steps || result.steps.length === 0) throw new Error("Native action transaction returned no checked steps.");
		const execution = aggregateExecutions(result.steps.map((step) => executionTraceFromAct(step, policy)));
		const batchTrace = executionTraceFromAct(result, policy);
		execution.outcome = result.outcome;
		execution.performed = result.performed;
		execution.rootDelta = batchTrace.rootDelta;
		execution.stoppedAt = result.stoppedAt;
		return execution;
	}
	const steps: ExecutionTrace[] = [];
	const actionState: ActionState = { currentFocus: false };
	for (const action of actions) {
		const step = await dispatchUiAction(action, target, look, headless, actionState, signal);
		steps.push(step);
		if (step.outcome !== "worked") break;
	}
	return aggregateExecutions(steps);
}

function aggregateExecutions(steps: ExecutionTrace[]): ExecutionTrace {
	const outcomes = steps.map((step) => step.outcome);
	const outcome: ActOutcome = outcomes.includes("didnt") ? "didnt" : outcomes.includes("unknown") ? "unknown" : "worked";
	const fallback = steps.find((step) => step.escalatedToForeground);
	return executionTrace("act", steps.every((step) => step.variant === "stealth") ? "stealth" : "default", {
		outcome,
		steps,
		actionCount: steps.length,
		rootDelta: steps.flatMap((step) => step.rootDelta ?? []),
		backgroundFirst: true,
		escalatedToForeground: Boolean(fallback),
		escalationReason: fallback?.escalationReason,
		backgroundAttempt: fallback?.backgroundAttempt,
	});
}

function exactPlatformRootMatchesTarget(root: HelperWindow, target: ResolvedTarget): boolean {
	if (root.pid !== target.pid) return false;
	const nativeRefMatches = Boolean(target.nativeWindowRef && (root.rootRef === target.nativeWindowRef || root.windowRef === target.nativeWindowRef));
	const windowIdMatches = target.windowId > 0 && root.windowId === target.windowId;
	return nativeRefMatches || windowIdMatches;
}

function clearDesktopOperationState(state: OperationState): void {
	state.currentTarget = undefined;
	state.currentCapture = undefined;
	state.currentStateTarget = undefined;
	state.currentLook = undefined;
	state.currentOutline = undefined;
	state.currentNote = undefined;
}

async function terminalDesktopActionResult(
	target: ResolvedTarget,
	baseStateId: string,
	execution: ExecutionTrace,
	error: unknown,
	condition?: ReturnType<typeof validateCondition>,
): Promise<AgentToolResult<TerminalDesktopActionDetails>> {
	let exactRootAvailable: boolean | undefined;
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const roots = await currentPlatformBackend.listRoots({ pid: target.pid });
			exactRootAvailable = roots.some((root) => exactPlatformRootMatchesTarget(root, target));
			if (exactRootAvailable) break;
			if (attempt < 2) await sleep(75);
		}
	} catch {
		// A failed identity probe cannot prove that the root closed.
	}
	const targetClosed = exactRootAvailable === false;
	if (targetClosed && !(execution.rootDelta ?? []).some((delta) => delta.change === "closed" && delta.pid === target.pid && (delta.ref === target.windowRef || delta.ref === target.nativeWindowRef))) {
		execution.rootDelta = [
			...(execution.rootDelta ?? []),
			{
				change: "closed",
				kind: "window",
				ref: target.windowRef,
				title: target.windowTitle,
				pid: target.pid,
				metadata: { source: "post_action_identity_probe" },
			},
		];
	}
	if (targetClosed && condition) {
		const verificationStatus = condition.gone ? "verified" : "failed";
		execution.verification = {
			status: verificationStatus,
			text: condition.text,
			role: condition.role,
			value: condition.value,
			gone: condition.gone || undefined,
			timeoutMs: condition.timeoutMs,
		};
		execution.outcome = outcomeAfterCheck(execution.outcome ?? "unknown", verificationStatus);
		if (verificationStatus === "failed") {
			execution.error = {
				code: "postcondition_failed",
				message: "The source root closed before the requested presence or value postcondition could be verified.",
			};
		}
	}
	const status = targetClosed ? "target_closed" : "post_action_observation_failed";
	const code = targetClosed ? "target_closed" : "post_action_observation_failed";
	const message = error instanceof Error ? error.message : String(error);
	clearDesktopOperationState(operationState());
	const details: TerminalDesktopActionDetails = {
		tool: "act_ui",
		status,
		baseStateId,
		target: {
			app: target.appName,
			bundleId: target.bundleId,
			pid: target.pid,
			windowTitle: target.windowTitle,
			windowId: target.windowId,
			windowRef: target.windowRef,
			nativeWindowRef: target.nativeWindowRef,
		},
		execution,
		error: { code, message },
	};
	const result = targetClosed
		? `The action was delivered, and its source root ${target.appName} — ${target.windowTitle} closed before a successor observation could be captured.`
		: `The action was delivered, but its source root ${target.appName} — ${target.windowTitle} could not be observed afterward: ${message}`;
	return {
		content: [{ type: "text", text: `${result}\nNo successor state was created. Call find_roots, then observe_ui to continue.` }],
		details,
	};
}

async function performDesktopTransaction(params: ActParams, actions: UiAction[], signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | TerminalDesktopActionDetails>> {
	const state = operationState();
	state.currentImageMode = "auto";
	validateStateId(params.stateId);
	const look = currentLookOrThrow();
	const baseView = { stateId: state.currentCapture!.stateId, outline: state.currentOutline! };
	const condition = params.expect ? validateCondition(params.expect) : undefined;
	const scopeNode = condition ? conditionScopeNode(look.parsedOutline!, condition) : undefined;
	const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
	const noteBefore = state.currentNote;
	const lease = transactionLeaseContext(actions, look.parsedOutline);
	return await withWindowWriteLock(target, async () => {
		const headless = getComputerUseConfig().headless;
		const execution = await dispatchUiTransaction(actions, target, look, headless, signal);
		const executedActions = actions.slice(0, execution.actionCount ?? actions.length);
		try {
			if (condition) {
				const { text: expectedText, role: expectedRole, value: expectedValue, scopeExact, gone, timeoutMs } = condition;
				const beforePresent = outlineConditionPresent(look.parsedOutline!, condition);
				const desiredWasPreexisting = beforePresent !== gone;
				const verification = await currentPlatformBackend.waitFor({
					...nativeWindowRequest(target),
					lookId: look.parsedOutline!.lookId,
					text: expectedText,
					role: platformRole(look.parsedOutline!, expectedRole),
					value: expectedValue,
					scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
					scopeExact,
					gone,
					timeoutMs,
				}, { signal, timeoutMs: timeoutMs + 2_000 });
				execution.verification = {
					status: verification.found ? (desiredWasPreexisting ? "preexisting" : "verified") : "failed",
					text: expectedText,
					role: expectedRole,
					value: expectedValue,
					gone: gone || undefined,
					timeoutMs,
				};
				execution.outcome = outcomeAfterCheck(execution.outcome ?? "unknown", execution.verification.status);
				if (!verification.found) {
					execution.error = {
						code: "postcondition_failed",
						message: `The action was delivered but its postcondition was not satisfied within ${timeoutMs}ms.`,
					};
				}
			} else {
				await sleep(settleMsForExecution(execution), signal);
			}
			const capture = await captureCurrentTarget(signal, "auto", AUTO_IMAGE_MAX_DIMENSION, target);
			execution.outcome = outcomeAfterObservedValues(execution.outcome ?? "unknown", executedActions, (ref) => nodeByRef(capture.outline, ref)?.value);
			for (const action of executedActions) {
				state.currentNote = noteAfterAct(state.currentNote ?? noteBefore, action.ref, capture.outline, { window: noteWindowForTarget(capture.target, capture.look), rootDelta: execution.rootDelta });
			}
			return await buildToolResult("act_ui", `Executed ${executedActions.length} checked UI action${executedActions.length === 1 ? "" : "s"} in ${target.appName} — ${target.windowTitle}. Returned state ${capture.capture.stateId}.`, capture, execution, signal, state.currentImageMode, baseView);
		} catch (error) {
			if (signal?.aborted) {
				clearDesktopOperationState(state);
				throw error;
			}
			return await terminalDesktopActionResult(target, baseView.stateId, execution, error, condition);
		}
	}, lease);
}

/**
 * Describe the transaction to the policy layer: action names for tiering and the
 * resolved element text for sensitive-action matching. The label is a summary,
 * not the full extracted text the model already sees.
 */
function transactionLeaseContext(actions: UiAction[], outline: Outline | undefined): LeaseContext {
	const names = [...new Set(actions.map((action) => action.action))];
	const refAction = actions.length === 1 ? actions[0] : undefined;
	const node = refAction?.ref && outline ? nodeByRef(outline, refAction.ref) : undefined;
	return { action: { name: names.join("+"), label: trimOrUndefined(node ? outlineNodeLabel(node) : undefined) } };
}

async function performBrowserTransaction(params: ActParams, actions: UiAction[], signal?: AbortSignal): Promise<AgentToolResult<BrowserObservationDetails>> {
	const contextId = browserContextForOperation();
	if (!contextId) throw new Error("Browser transaction requires a browser observation state.");
	const baseSnapshot = operationState().browserSnapshot;
	if (!baseSnapshot) throw new Error("Browser transaction requires a complete base observation.");
	const baseView = { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline };
	const condition = params.expect ? validateCondition(params.expect) : undefined;
	if (condition) conditionScopeNode(restoreOutline(baseSnapshot.outline), condition);
	const prepared = actions.map((action) => {
		if (!BROWSER_TRANSACTION_ACTIONS.has(action.action)) throw new Error(`Browser transactions do not support '${action.action}'.`);
		if (action.action === "click" && action.ref && action.button && action.button !== "left") throw new Error("Browser ref clicks support only the left button; use coordinate clicks for right or middle buttons.");
		const target = browserSnapshotTarget(params.stateId, trimOrUndefined(action.ref));
		if ((action.action === "press" || action.action === "setText" || (action.action === "click" && action.ref) || (action.action === "typeText" && action.ref)) && !Number.isFinite(target?.backendNodeId)) {
			throw new Error(`Browser ${action.action} requires an actionable @e ref owned by ${params.stateId}.`);
		}
		if (action.ref && (!target || target.contextId !== contextId)) throw new Error(`Browser ${action.action} ref must be owned by ${params.stateId}.`);
		return { action, target };
	});
	const lease = { action: { name: [...new Set(actions.map((action) => action.action))].join("+") } };
	return await withBrowserWrite(contextId, async () => {
		for (const { action, target } of prepared) {
			let worked = false;
			if (action.action === "press" || (action.action === "click" && action.ref)) {
				worked = true;
				for (let count = 0; count < (action.clickCount ?? 1); count += 1) worked = await cdpClickForContext(contextId, target!.backendNodeId!) && worked;
			} else if (action.action === "click") {
				worked = await cdpMouseForContext(contextId, action.x!, action.y!, "mousePressed", action.button ?? "left", action.clickCount ?? 1)
					&& await cdpMouseForContext(contextId, action.x!, action.y!, "mouseReleased", action.button ?? "left", action.clickCount ?? 1);
			} else if (action.action === "setText") worked = await cdpTypeForContext(contextId, target!.backendNodeId!, action.text ?? "", true);
			else if (action.action === "typeText") worked = target?.backendNodeId
				? await cdpTypeForContext(contextId, target.backendNodeId, action.text ?? "", false)
				: await cdpTypeFocusedForContext(contextId, action.text ?? "");
			else if (action.action === "keypress") worked = await cdpKeypressForContext(contextId, action.keys ?? []);
			else if (action.action === "scroll") worked = await cdpScrollForContext(contextId, toFiniteNumber(action.scrollX, 0), toFiniteNumber(action.scrollY, 0), target?.backendNodeId);
			else if (action.action === "drag") worked = await cdpDragForContext(contextId, normalizeActionPath(action.path));
			else if (action.action === "moveMouse") worked = await cdpMouseForContext(contextId, action.x!, action.y!, "mouseMoved");
			if (!worked) throw new Error("The browser root became unavailable during the action transaction. Observe it again.");
		}
		if (condition) {
			const deadline = Date.now() + condition.timeoutMs;
			let satisfied = false;
			do {
				const snapshot = await cdpSnapshotForContext(contextId);
				if (!snapshot) throw new Error(`Browser root '${contextId}' is no longer available. Observe it again.`);
				const present = outlineConditionPresent(restoreOutline(snapshot.outline), condition);
				satisfied = present !== condition.gone;
				if (!satisfied) await sleep(100, signal);
			} while (!satisfied && Date.now() < deadline);
			if (!satisfied) throw new Error(`The browser action was delivered but its postcondition was not satisfied within ${condition.timeoutMs}ms.`);
		}
		return await refreshBrowserSnapshot(contextId, "act_ui", baseView);
	}, lease);
}

function normalizeActionPath(path: UiAction["path"]): Array<{ x: number; y: number }> {
	return (path ?? []).map((point) => Array.isArray(point) ? { x: toFiniteNumber(point[0], 0), y: toFiniteNumber(point[1], 0) } : { x: toFiniteNumber(point.x, 0), y: toFiniteNumber(point.y, 0) });
}

function validateActionTarget(action: UiAction): void {
	const hasRef = Boolean(trimOrUndefined(action.ref));
	const hasX = Number.isFinite(action.x);
	const hasY = Number.isFinite(action.y);
	if (hasX !== hasY) throw new Error(`${action.action} coordinates require both x and y.`);
	const hasPoint = hasX && hasY;
	if ((action.action === "click" || action.action === "moveMouse") && hasRef === hasPoint) {
		throw new Error(`${action.action} requires exactly one target: ref or x/y coordinates.`);
	}
	if (action.action === "press" && !hasRef) throw new Error("press requires an actionable ref.");
	if (action.action === "scroll" && toFiniteNumber(action.scrollX, 0) === 0 && toFiniteNumber(action.scrollY, 0) === 0) throw new Error("scroll requires a non-zero scrollX or scrollY delta.");
	if (action.clickCount !== undefined && (!Number.isInteger(action.clickCount) || action.clickCount < 1 || action.clickCount > 3)) throw new Error("clickCount must be an integer from 1 to 3.");
}

async function performAct(params: ActParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | TerminalDesktopActionDetails | BrowserObservationDetails>> {
	const actions = Array.isArray(params.actions) ? params.actions : [];
	if (actions.length === 0) throw new Error("act_ui.actions must contain at least one action.");
	if (actions.length > 20) throw new Error("act_ui supports at most 20 actions per transaction.");
	for (const action of actions) validateActionTarget(action);
	if (operationState().contextId) return await performBrowserTransaction(params, actions, signal);
	return await performDesktopTransaction(params, actions, signal);
}

function managedBrowserExecutableCandidates(browser: "helium" | "chrome"): string[] {
	const overrideName = browser === "helium" ? "PI_COMPUTER_USE_HELIUM_EXECUTABLE" : "PI_COMPUTER_USE_CHROME_EXECUTABLE";
	const override = trimOrUndefined(process.env[overrideName]);
	if (override) return [path.resolve(override)];

	const platformCandidates = process.platform === "darwin"
		? browser === "helium"
			? [
				"/Applications/Helium.app/Contents/MacOS/Helium",
				path.join(os.homedir(), "Applications", "Helium.app", "Contents", "MacOS", "Helium"),
			]
			: [
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
			]
		: process.platform === "win32"
			? browser === "helium"
				? [
					process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Helium", "Application", "helium.exe"),
					process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Helium", "Application", "helium.exe"),
				]
				: [
					process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
					process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
					process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
				]
			: browser === "helium"
				? [
					"/usr/bin/helium",
					"/usr/bin/helium-browser",
					"/opt/helium/chrome",
					path.join(os.homedir(), ".local", "helium", "chrome"),
				]
				: [
					"/usr/bin/google-chrome",
					"/usr/bin/google-chrome-stable",
					"/usr/bin/chromium",
					"/usr/bin/chromium-browser",
					"/snap/bin/chromium",
				];
	const pathNames = browser === "helium"
		? process.platform === "win32" ? ["helium.exe"] : ["helium", "helium-browser"]
		: process.platform === "win32" ? ["chrome.exe"] : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
	const pathCandidates = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.flatMap((directory) => pathNames.map((name) => path.join(directory, name)));
	return [...new Set([...platformCandidates.filter((candidate): candidate is string => Boolean(candidate)), ...pathCandidates])];
}

async function managedBrowserExecutable(browser: "helium" | "chrome"): Promise<string> {
	const candidates = managedBrowserExecutableCandidates(browser);
	for (const candidate of candidates) {
		try {
			await access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next platform-appropriate installation location.
		}
	}
	const overrideName = browser === "helium" ? "PI_COMPUTER_USE_HELIUM_EXECUTABLE" : "PI_COMPUTER_USE_CHROME_EXECUTABLE";
	if (trimOrUndefined(process.env[overrideName])) {
		throw new Error(`${browser} executable from ${overrideName} was not found or is not executable: ${candidates[0]}.`);
	}
	throw new Error(`${browser} executable was not found. Set ${overrideName} to its absolute path.`);
}

function freeTcpPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => port > 0 ? resolve(port) : reject(new Error("Could not allocate a local CDP port.")));
		});
	});
}

async function waitForCdpPort(port: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + MANAGED_BROWSER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Browser launch was aborted.");
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
			if (response.ok) return;
		} catch {
			// Browser is still starting.
		}
		await sleep(200, signal);
	}
	throw new Error(`Managed browser did not expose CDP on port ${port} within ${MANAGED_BROWSER_READY_TIMEOUT_MS}ms.`);
}

// Side effects: starts a Pi-managed browser process, replaces any previous managed browser,
// and sets PI_COMPUTER_USE_CDP_PORT for subsequent CDP context discovery.
async function performLaunchBrowser(params: LaunchBrowserParams, signal?: AbortSignal): Promise<AgentToolResult<BrowserObservationDetails>> {
	const browser = getComputerUseConfig().managed_browser;
	const executable = await managedBrowserExecutable(browser);
	const port = await freeTcpPort();
	const requestedUrl = trimOrUndefined(params.url);
	if (requestedUrl && !/^https?:\/\//i.test(requestedUrl)) throw new Error("launch_browser.url must be an absolute HTTP(S) URL.");
	const url = requestedUrl ?? "about:blank";
	const profileDir = path.join(os.tmpdir(), `pi-${browser}-cdp-${port}`);
	disconnectCdp();
	runtimeState.managedBrowser?.kill("SIGTERM");
	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		url,
	];
	if (runtimeState.previousCdpPort === undefined && runtimeState.managedBrowserCdpPort === undefined) {
		runtimeState.previousCdpPort = process.env.PI_COMPUTER_USE_CDP_PORT;
	}
	const managedBrowser = spawn(executable, args, { stdio: "ignore", detached: false });
	managedBrowser.unref();
	runtimeState.managedBrowser = managedBrowser;
	runtimeState.managedBrowserCdpPort = String(port);
	process.env.PI_COMPUTER_USE_CDP_PORT = String(port);
	try {
		await waitForCdpPort(port, signal);
	} catch (error) {
		if (runtimeState.managedBrowser === managedBrowser) {
			runtimeState.managedBrowser = undefined;
			managedBrowser.kill("SIGTERM");
			if (runtimeState.previousCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
			else process.env.PI_COMPUTER_USE_CDP_PORT = runtimeState.previousCdpPort;
			runtimeState.managedBrowserCdpPort = undefined;
			runtimeState.previousCdpPort = undefined;
		}
		throw error;
	}
	const page = (await listCdpPageContexts())[0];
	if (!page) throw new Error("Managed browser launched without a CDP page context.");
	const resourceKey = `cdp:${page.targetId}`;
	const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(page.contextId));
	if (!scheduled.value) throw new Error("Managed browser page could not be observed after launch.");
	return browserObservationResult(scheduled.value, resourceKey, await resourceScheduler.syncEpoch(resourceKey), "launch_browser");
}

async function performNavigateBrowser(params: NavigateBrowserParams): Promise<AgentToolResult<BrowserObservationDetails>> {
	const contextId = browserContextForOperation();
	const url = trimOrUndefined(params.url);
	if (!contextId) throw new Error("navigate_browser.stateId must belong to a CDP browser-page observation. Native browser windows use act_ui.");
	if (!url || !/^https?:\/\//i.test(url)) throw new Error("navigate_browser.url must be an absolute HTTP(S) URL.");
	const baseSnapshot = operationState().browserSnapshot;
	if (!baseSnapshot) throw new Error("Browser navigation requires a complete base observation.");
	return await withBrowserWrite(contextId, async () => {
		const ok = await cdpNavigateContext(contextId, url);
		if (!ok) throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
		return await refreshBrowserSnapshot(contextId, "navigate_browser", { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline });
	});
}

async function performEvaluateBrowser(params: EvaluateBrowserParams): Promise<AgentToolResult<EvaluateBrowserDetails>> {
	const contextId = browserContextForOperation();
	const expression = typeof params.expression === "string" ? params.expression : "";
	if (!contextId) throw new Error("evaluate_browser.stateId must belong to a browser observation.");
	if (!expression.trim()) throw new Error("evaluate_browser.expression must be non-empty JavaScript.");
	const baseSnapshot = operationState().browserSnapshot;
	if (!baseSnapshot) throw new Error("Browser evaluation requires a complete base observation.");
	return await withBrowserWrite(contextId, async () => {
		const result = await cdpEvaluateForContext(contextId, expression);
		if (!result) throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
		const successor = await refreshBrowserSnapshot(contextId, "evaluate_browser", { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline });
		const details: EvaluateBrowserDetails = {
			tool: "evaluate_browser",
			baseStateId: baseSnapshot.snapshotId,
			stateId: successor.details.stateId,
			view: successor.details.view,
			changes: successor.details.changes,
			outline: successor.details.outline,
			renderedOutline: successor.details.renderedOutline,
		};
		return { content: [...successor.content, { type: "text", text: `Evaluation value: ${JSON.stringify(result.value)}` }], details };
	});
}

async function executeTool<P, T>(ctx: ExtensionContext, params: P, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
	const outputRef = trimOrUndefined((params as { ref?: string } | undefined)?.ref)?.startsWith("@o") === true;
	const requestedStateId = outputRef ? undefined : trimOrUndefined((params as { stateId?: string } | undefined)?.stateId);
	const stateRecord = requestedStateId ? savedStates.get(requestedStateId) : undefined;
	if (requestedStateId && !stateRecord) {
		throw new Error(`State '${requestedStateId}' is unavailable or was evicted. Observe the root again.`);
	}
	const operation = savedStates.hydrate(stateRecord);
	return await savedStates.operations.run(operation, async () => {
		await resourceScheduler.read("session-lifecycle", async () => await ensureReady(ctx, signal));
		throwIfAborted(signal);
		const result = await run();
		persistOperation(operation);
		return result;
	});
}

function leaseConflictResult(tool: string, error: LeaseUnavailableError): AgentToolResult<LeaseConflictDetails> {
	const retry: LeaseConflictDetails["retry"] = error.code === "resource_busy" || error.code === "broker_unavailable" ? "safe" : "never";
	const holder = error.holder
		? ` Held by agent ${error.holder.agentId} (${Math.ceil(error.holder.remainingMs / 1000)}s remaining).`
		: "";
	const next = retry === "safe"
		? " Nothing was delivered. Retry after that agent releases the app, or ask the user to stop it from the menu bar or with Ctrl+Option+Cmd+."
		: " Nothing was delivered.";
	return {
		content: [{ type: "text", text: `${tool} did not run: ${error.message}${holder}${next}` }],
		details: {
			tool,
			status: "lease_conflict",
			code: error.code,
			message: error.message,
			leaseHolder: error.holder ? { agentId: error.holder.agentId, remainingMs: error.holder.remainingMs } : undefined,
			retry,
		},
	};
}

/**
 * Write one trace line for a finished tool call.
 *
 * Only metadata and redacted evidence: the tool name, the resolved target,
 * delivery level, status, screenshot file names and, for text input, the length
 * and SHA-256 of what was typed. Params are passed through `redactParams` so a
 * new action cannot leak its payload by accident.
 */
function recordToolTrace(
	ctx: ExtensionContext,
	tool: string,
	params: unknown,
	startedAt: number,
	outcome: { result?: AgentToolResult<unknown>; error?: unknown; status?: TraceEntry["status"] },
): void {
	const recorder = sessionTrace(ctx);
	if (!recorder) return;
	const redacted = redactParams(params) as Record<string, unknown> | undefined;
	const typed = firstRedactedText(redacted);
	const result = outcome.result as { content?: Array<{ type: string; data?: string; mimeType?: string }>; details?: any } | undefined;
	const details = result?.details;
	const execution = details?.execution ?? details?.capture?.execution;
	const shots: string[] = [];
	// A secure text field must not be photographed, even for our own trace (review
	// I1). The native helper has no secure-field marker yet, so the role in the
	// result is the only signal; when the outline says secure, the image is dropped.
	const secure = /AXSecureTextField/.test(JSON.stringify(details?.outline ?? details?.capture?.outline ?? details?.target ?? ""));
	if (getComputerUseConfig().trace_screenshots && !secure) {
		for (const item of result?.content ?? []) {
			if (item.type !== "image" || !item.data) continue;
			const extension = item.mimeType === "image/png" ? "png" : "jpg";
			const saved = recorder.saveScreenshot(item.data, extension);
			if (saved) shots.push(saved);
		}
	}
	const target = redacted
		? {
			role: typeof redacted.role === "string" ? redacted.role : undefined,
			ref: typeof redacted.ref === "string" ? redacted.ref : (Array.isArray(redacted.actions) ? (redacted.actions as any[]).map((action) => action?.ref).filter((value) => typeof value === "string")[0] : undefined),
			app: details?.target?.appName ?? details?.target?.app,
			window: details?.target?.windowTitle,
		}
		: undefined;
	const status: TraceEntry["status"] = outcome.status ?? (outcome.error ? "error" : traceStatusOf(details));
	recorder.record({
		tool,
		status,
		target: target && (target.role || target.ref || target.app) ? target : undefined,
		durationMs: Date.now() - startedAt,
		deliveryLevel: typeof execution?.deliveryLevel === "string" ? execution.deliveryLevel : (typeof execution?.delivery === "string" ? execution.delivery : undefined),
		text: typed,
		screenshots: shots.length ? shots : undefined,
		evidence: traceEvidenceOf(details, outcome.error),
		lease: details?.leaseHolder?.agentId ? { holder: details.leaseHolder.agentId } : undefined,
	});
}

function firstRedactedText(params: Record<string, unknown> | undefined): TraceEntry["text"] | undefined {
	if (!params) return undefined;
	const candidates: unknown[] = [params.text, ...(Array.isArray(params.actions) ? (params.actions as any[]).map((action) => action?.text) : [])];
	for (const candidate of candidates) {
		if (candidate && typeof candidate === "object" && "sha256" in candidate && "length" in candidate) {
			return candidate as TraceEntry["text"];
		}
	}
	return undefined;
}

function traceStatusOf(details: any): TraceEntry["status"] {
	const status = details?.status ?? details?.execution?.outcome;
	if (status === undefined) return "ok";
	if (status === "unknown") return "unknown";
	if (details?.stoppedAt || details?.stopped_by_user) return "stopped";
	return "ok";
}

function traceEvidenceOf(details: any, error: unknown): string | undefined {
	if (error) return error instanceof LeaseUnavailableError ? `lease ${error.code}` : "tool error";
	const parts: string[] = [];
	if (typeof details?.capture?.stateId === "string") parts.push(`state ${details.capture.stateId}`);
	if (typeof details?.changedNodeCount === "number") parts.push(`${details.changedNodeCount} nodes changed`);
	if (typeof details?.status === "string") parts.push(details.status);
	return parts.length ? parts.join("; ") : undefined;
}

function makeToolExecutor<P, D>(tool: string, perform: (params: P, signal?: AbortSignal) => Promise<AgentToolResult<D>>) {
	return async (
		_toolCallId: string,
		params: P,
		signal: AbortSignal | undefined,
		_onUpdate: AgentToolUpdateCallback<D> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<D>> => {
		const startedAt = Date.now();
		try {
			const result = applyOutputEnvelope(tool, await executeTool(ctx, params, signal, () => perform(params, signal)));
			recordToolTrace(ctx, tool, params, startedAt, { result });
			return result;
		} catch (error) {
			// A refused write authority is a reported outcome, not an exception:
			// nothing was dispatched, and the model needs the holder to explain it.
			if (error instanceof LeaseUnavailableError) {
				const conflict = applyOutputEnvelope(tool, leaseConflictResult(tool, error) as AgentToolResult<D>);
				recordToolTrace(ctx, tool, params, startedAt, { result: conflict, status: "lease_conflict" });
				return conflict;
			}
			recordToolTrace(ctx, tool, params, startedAt, { error });
			throw boundToolError(tool, error);
		}
	};
}

export const executeFind = makeToolExecutor("find_roots", performListWindows);
export const executeReadText = makeToolExecutor("read_text", performReadText);
export const executeWaitFor = makeToolExecutor("wait_for", performWaitFor);
export const executeObserve = makeToolExecutor("observe_ui", performObserve);
export const executeSearchUi = makeToolExecutor("search_ui", performSearchUi);
export const executeExpandUi = makeToolExecutor("expand_ui", performExpandUi);
export const executeInspectUi = makeToolExecutor("inspect_ui", performInspectUi);
export const executeAct = makeToolExecutor<ActParams, ComputerUseDetails | TerminalDesktopActionDetails | BrowserObservationDetails>("act_ui", performAct);
export const executeNavigateBrowser = makeToolExecutor("navigate_browser", performNavigateBrowser);
export const executeEvaluateBrowser = makeToolExecutor("evaluate_browser", performEvaluateBrowser);
// MARK: - Computer Use v2 administration tools

const CLIPBOARD_RESTORE_MS = 30_000;

/**
 * Record why a clipboard restore was skipped. The trace is the only place that can
 * answer "did the agent touch my clipboard and leave it alone afterwards?", and it
 * stores a reason code only — never clipboard content.
 */
function recordClipboardRestoreSkip(reason: "user_changed_clipboard" | "no_snapshot" | "restore_failed"): void {
	const recorder = activeTraceRecorder();
	recorder?.record({ tool: "clipboard", status: "unknown", evidence: `restore_skipped:${reason}`, clipboardRestoreSkipped: reason });
}
let clipboardRestoreTimer: ReturnType<typeof setTimeout> | undefined;

function clearClipboardRestoreTimer(): void {
	if (clipboardRestoreTimer) clearTimeout(clipboardRestoreTimer);
	clipboardRestoreTimer = undefined;
}

/**
 * Restore the user's clipboard after a write.
 *
 * Writing the clipboard is a visible side effect on the user's own machine, so a
 * `set` puts the previous text back after 30 seconds unless the user turned
 * restoration off.
 */
/**
 * Put the user's clipboard back after an agent write.
 *
 * Two rules, both learned from review B4:
 *  1. Restore only while the clipboard still holds exactly what the agent wrote.
 *     If the user copied something in the meantime, overwriting it would be the
 *     very interference this feature exists to avoid, so we leave it alone.
 *  2. The snapshot covers every item and type, so images and file promises come
 *     back too. A clipboard we cannot capture is refused before the write, never
 *     silently dropped afterwards.
 */
export function scheduleClipboardRestore(options: {
	snapshot: PlatformClipboardSnapshot | undefined;
	/** changeCount observed right after the agent's write. */
	writtenChangeCount: number;
	restore: boolean;
	snapshotNow?: () => Promise<PlatformClipboardSnapshot>;
	write: (snapshot: PlatformClipboardSnapshot) => Promise<unknown>;
	onSkip?: (reason: "user_changed_clipboard" | "no_snapshot" | "restore_failed") => void;
	delayMs?: number;
	setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
}): boolean {
	if (!options.restore || !options.snapshot) return false;
	clearClipboardRestoreTimer();
	const delay = options.delayMs ?? CLIPBOARD_RESTORE_MS;
	const setTimer = options.setTimer ?? setTimeout;
	clipboardRestoreTimer = setTimer(() => {
		clipboardRestoreTimer = undefined;
		void (async () => {
			const current = await options.snapshotNow?.().catch(() => undefined);
			if (!current || current.changeCount !== options.writtenChangeCount) {
				options.onSkip?.("user_changed_clipboard");
				return;
			}
			await options.write(options.snapshot as PlatformClipboardSnapshot).catch(() => options.onSkip?.("restore_failed"));
		})();
	}, delay);
	clipboardRestoreTimer.unref?.();
	return true;
}

async function performClipboard(params: { action: "get" | "set" | "clear"; text?: string }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	const backend = currentPlatformBackend;
	// Clipboard reads and writes are authorized per level and serialized through one
	// lease: an approval card or a running peer must both be respected (review B2).
	const clipboardLease = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
		const key = "clipboard:system";
		const baseEpoch = resourceScheduler.epoch(key);
		const result = await resourceScheduler.write(key, baseEpoch, async () => await work(), {
			action: { name: `clipboard_${label}`, label: "System clipboard" },
			app: { appName: "System Clipboard" },
		});
		return result.value;
	};
	if (params.action === "get") {
		if (!backend.clipboardGet) return unsupportedToolResult("clipboard", "get", "This platform cannot read the clipboard.");
		const read = await clipboardLease("get", async () => await backend.clipboardGet!());
		return {
			content: [{ type: "text", text: read.available ? `Clipboard contains ${read.text.length} characters${read.truncated ? " (truncated)" : ""}.` : "Clipboard is empty." }],
			details: { tool: "clipboard", action: "get", status: "ok", ...read },
		};
	}
	if (params.action === "clear") {
		if (!backend.clipboardClear) return unsupportedToolResult("clipboard", "clear", "This platform cannot clear the clipboard.");
		const cleared = await clipboardLease("clear", async () => await backend.clipboardClear!());
		return {
			content: [{ type: "text", text: "Cleared the clipboard." }],
			details: { tool: "clipboard", action: "clear", status: "ok", ...cleared },
		};
	}
	if (!backend.clipboardSet) return unsupportedToolResult("clipboard", "set", "This platform cannot write the clipboard.");
	const text = params.text ?? "";
	// Capture before writing: a clipboard whose types cannot be copied exactly is
	// refused, because a partial restore would destroy the user's content.
	const snapshot = await backend.clipboardSnapshot?.().catch(() => undefined);
	const written = await clipboardLease("set", async () => await backend.clipboardSet!(text));
	const restore = scheduleClipboardRestore({
		snapshot,
		writtenChangeCount: written.changeCount,
		restore: getComputerUseConfig().clipboard_restore,
		snapshotNow: async () => await backend.clipboardSnapshot?.() as PlatformClipboardSnapshot,
		write: async (value) => await backend.clipboardRestore?.(value),
		onSkip: (reason) => recordClipboardRestoreSkip(reason),
	});
	return {
		content: [{
			type: "text",
			text: written.changed === false
				? "The clipboard refused the new text."
				: `Wrote ${[...text].length} characters to the clipboard${restore ? "; the previous clipboard content is restored in 30 seconds unless you copy something else first" : ""}.`,
		}],
		details: { tool: "clipboard", action: "set", status: written.changed === false ? "didnt" : "ok", ...written, restores: restore },
	};
}

/**
 * Resolve the app identity the policy layer needs. Without it the broker can only
 * apply the anonymous-resource rule, which is a deliberate relaxation for
 * headless targets that have no identity at all.
 */
async function describeApp(pid?: number, bundleId?: string): Promise<{ appName: string; bundleId?: string } | undefined> {
	try {
		const apps = await listApps();
		const match = apps.find((app) => (pid !== undefined ? app.pid === pid : false) || (bundleId ? app.bundleId === bundleId : false));
		if (!match) return bundleId ? { appName: bundleId, bundleId } : undefined;
		return { appName: match.appName, ...(match.bundleId ? { bundleId: match.bundleId } : {}) };
	} catch {
		return bundleId ? { appName: bundleId, bundleId } : undefined;
	}
}

async function performManageApp(params: { action: "list" | "launch" | "quit"; bundleId?: string; path?: string; pid?: number; force?: boolean }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	const backend = currentPlatformBackend;
	if (params.action === "list") {
		const apps = await listApps();
		const lines = apps.map((app) => `${app.appName}${app.bundleId ? ` (${app.bundleId})` : ""} pid=${app.pid}${app.isFrontmost ? " frontmost" : ""}`);
		return {
			content: [{ type: "text", text: lines.length ? lines.join("\n") : "No applications are running." }],
			details: { tool: "manage_app", action: "list", status: "ok", apps },
		};
	}
	if (!backend.manageApps) return unsupportedToolResult("manage_app", params.action, "This platform cannot manage applications.");
	if (params.action === "quit") {
		if (params.pid === undefined && !params.bundleId) return toolProblem("manage_app", "quit requires pid or bundleId.");
		const appInfo = await describeApp(params.pid, params.bundleId);
		const quitKey = appInfo ? `app:${appInfo.bundleId ?? appInfo.appName}` : `desktop-pid:${params.pid ?? 0}`;
		const result = await resourceScheduler.write(quitKey, resourceScheduler.epoch(quitKey), async () =>
			await backend.manageApps!({ mode: "quit", pid: params.pid, bundleId: params.bundleId, force: params.force === true }), {
			action: { name: "manage_app_quit", label: appInfo?.appName ?? params.bundleId ?? "application" },
			...(appInfo ? { app: appInfo } : {}),
		}).then((outcome) => outcome.value);
		const quit = result as { terminated?: boolean; quitRequested?: boolean; unsavedChangesMayBlock?: boolean };
		const status = quit.terminated ? "worked" : quit.unsavedChangesMayBlock ? "unknown" : "didnt";
		return {
			content: [{
				type: "text",
				text: quit.terminated
					? "The application quit."
					: quit.quitRequested
						? "The quit request was accepted but the application is still running; it may be waiting on unsaved changes."
						: "The application refused to quit.",
			}],
			details: { tool: "manage_app", action: "quit", status, ...quit },
		};
	}
	if (!params.bundleId && !params.path) return toolProblem("manage_app", "launch requires bundleId or path.");
	const launchInfo = await describeApp(params.pid, params.bundleId);
	const launchKey = launchInfo ? `app:${launchInfo.bundleId ?? launchInfo.appName}` : `desktop-pid:${params.pid ?? 0}`;
	const launched = await resourceScheduler.write(launchKey, resourceScheduler.epoch(launchKey), async () =>
		await backend.manageApps!({ mode: "launch", bundleId: params.bundleId, path: params.path, activates: false }), {
		action: { name: "manage_app_launch", label: launchInfo?.appName ?? params.bundleId ?? params.path ?? "application" },
		...(launchInfo ? { app: launchInfo } : {}),
	}).then((outcome) => outcome.value);
	const launch = launched as { launched?: boolean; alreadyRunning?: boolean; pending?: boolean; pid?: number };
	return {
		content: [{
			type: "text",
			text: launch.launched
				? `Launched the application${launch.alreadyRunning ? " (it was already running)" : ""} without activating it${launch.pid ? `, pid ${launch.pid}` : ""}.`
				: launch.pending
					? "The launch is still in progress; nothing is active yet."
					: "The application did not launch.",
		}],
		details: { tool: "manage_app", action: "launch", status: launch.launched ? "ok" : launch.pending ? "unknown" : "didnt", ...launch },
	};
}

async function performManageWindow(params: { action: "list" | "move" | "resize" | "minimize" | "restore" | "maximize" | "list_displays"; pid?: number; windowId?: number; x?: number; y?: number; w?: number; h?: number; title?: string }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	const backend = currentPlatformBackend;
	if (!backend.manageWindow) return unsupportedToolResult("manage_window", params.action, "This platform cannot manage windows.");
	if (params.action === "list" || params.action === "list_displays") {
		const result = await backend.manageWindow(params.action === "list"
			? { mode: "list", pid: params.pid, title: params.title }
			: { mode: "list_displays" });
		if (params.action === "list_displays") {
			const displays = result as Array<{ name: string; frame: { x: number; y: number; w: number; h: number }; isMain: boolean; scaleFactor: number }>;
			const lines = displays.map((display) => `${display.name}${display.isMain ? " (main)" : ""} ${Math.round(display.frame.w)}x${Math.round(display.frame.h)} @${display.scaleFactor}x at ${Math.round(display.frame.x)},${Math.round(display.frame.y)}`);
			return {
				content: [{ type: "text", text: lines.length ? lines.join("\n") : "No displays were reported." }],
				details: { tool: "manage_window", action: "list_displays", status: "ok", displays },
			};
		}
		const roots = result as HelperWindow[];
		const windows = collectBroadWindowDetails(roots, getComputerUseConfig());
		return {
			content: [{ type: "text", text: windows.length ? windows.map(formatWindowLine).join("\n") : "No windows matched." }],
			details: { tool: "manage_window", action: "list", status: "ok", windows },
		};
	}
	if (params.windowId === undefined || params.pid === undefined) return toolProblem("manage_window", `${params.action} requires pid and windowId.`);
	const windowKey = `desktop-pid:${params.pid}`;
	const result = await resourceScheduler.write(windowKey, resourceScheduler.epoch(windowKey), async () =>
		await backend.manageWindow!({ mode: params.action, pid: params.pid, windowId: params.windowId, x: params.x, y: params.y, w: params.w, h: params.h }), {
		action: { name: `manage_window_${params.action}`, label: `window ${params.windowId}` },
		...(await describeApp(params.pid) ?? {}),
	}).then((outcome) => outcome.value);
	const mutation = result as { outcome?: string; before?: unknown; after?: unknown };
	return {
		content: [{
			type: "text",
			text: mutation.outcome === "worked"
				? `Window ${params.windowId}: ${params.action} applied. Never activated or raised.`
				: `Window ${params.windowId}: ${params.action} did not change the window (${mutation.outcome ?? "unknown"}).`,
		}],
		details: { tool: "manage_window", action: params.action, status: mutation.outcome === "worked" ? "ok" : mutation.outcome === "didnt" ? "didnt" : "unknown", ...mutation },
	};
}

async function performSystemSurface(params: { surface: "notifications" | "menu_bar_extras" | "control_center" | "dock" | "all" }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	const backend = currentPlatformBackend;
	if (!backend.systemSurfaces) return unsupportedToolResult("system_surface", params.surface, "This platform does not expose system surfaces.");
	const surfaces = await backend.systemSurfaces(params.surface);
	const lines: string[] = [];
	const details: Record<string, unknown> = { tool: "system_surface", status: "ok", surfaces: {} };
	for (const [name, surface] of Object.entries(surfaces)) {
		const windows = surface.available ? collectBroadWindowDetails(surface.roots, getComputerUseConfig()) : [];
		(details.surfaces as Record<string, unknown>)[name] = { available: surface.available, bundleId: surface.bundleId, windows };
		if (!surface.available) {
			lines.push(`${name}: not running`);
			continue;
		}
		lines.push(`${name}: ${windows.length ? windows.map(formatWindowLine).join(" | ") : "no addressable roots"}`);
	}
	return {
		content: [{ type: "text", text: lines.length ? lines.join("\n") : "No system surfaces are available." }],
		details,
	};
}

async function performCuSession(params: { action: "status" | "release" | "trace_export" }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	if (params.action === "trace_export") {
		const recorder = activeTraceRecorder();
		if (!recorder) return unsupportedToolResult("cu_session", "trace_export", "Tracing is disabled for this session.");
		const markdown = exportTraceMarkdown(recorder.sessionDir, path.basename(recorder.filePath));
		return {
			content: [{ type: "text", text: markdown }],
			details: { tool: "cu_session", action: "trace_export", status: "ok", path: recorder.filePath },
		};
	}
	const session = brokerSession;
	if (!session) return unsupportedToolResult("cu_session", params.action, "The Desktop Broker is not attached to this session.");
	if (params.action === "status") {
		const status = await session.client.status();
		const lines = (status.agents ?? []).map((agent) => {
			const held = agent.leases.map((lease) => lease.resourceKey).join(", ");
			return `${agent.agentId}${agent.agentId === session.client.agentId ? " (this session)" : ""}${held ? ` holds ${held}` : " holds nothing"}`;
		});
		return {
			content: [{ type: "text", text: lines.length ? lines.join("\n") : "No agents are attached to the broker." }],
			details: { tool: "cu_session", action: "status", status: "ok", broker: status },
		};
	}
	const status = await session.client.status().catch(() => undefined);
	const held = status?.agents.find((agent) => agent.agentId === session.client.agentId)?.leases ?? [];
	await session.broker.releaseAll();
	return {
		content: [{ type: "text", text: held.length ? `Released ${held.length} lease(s): ${held.map((lease) => lease.resourceKey).join(", ")}.` : "This session held no leases." }],
		details: { tool: "cu_session", action: "release", status: "ok", released: held.map((lease) => lease.resourceKey) },
	};
}

function unsupportedToolResult(tool: string, action: string, message: string): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text: `${tool} ${action} is unavailable: ${message}` }], details: { tool, action, status: "unsupported" } };
}

function toolProblem(tool: string, message: string): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text: `${tool}: ${message}` }], details: { tool, status: "invalid_args", message } };
}

function activeTraceRecorder(): TraceRecorder | undefined {
	return traceRecorder;
}

export const executeLaunchBrowser = makeToolExecutor("launch_browser", performLaunchBrowser);
export const executeManageApp = makeToolExecutor<{ action: "list" | "launch" | "quit"; bundleId?: string; path?: string; pid?: number; force?: boolean }, Record<string, unknown>>("manage_app", performManageApp);
export const executeManageWindow = makeToolExecutor<{ action: "list" | "move" | "resize" | "minimize" | "restore" | "maximize" | "list_displays"; pid?: number; windowId?: number; x?: number; y?: number; w?: number; h?: number; title?: string }, Record<string, unknown>>("manage_window", performManageWindow);
export const executeClipboard = makeToolExecutor<{ action: "get" | "set" | "clear"; text?: string }, Record<string, unknown>>("clipboard", performClipboard);
export const executeSystemSurface = makeToolExecutor<{ surface: "notifications" | "menu_bar_extras" | "control_center" | "dock" | "all" }, Record<string, unknown>>("system_surface", performSystemSurface);
export const executeCuSession = makeToolExecutor<{ action: "status" | "release" | "trace_export" }, Record<string, unknown>>("cu_session", performCuSession);

export function reconstructStateFromBranch(ctx: ExtensionContext): void {
	savedStates.clear();
	clearStoredOutputs();
	runtimeState.windowRefs.clear();
	runtimeState.windowRefByIdentity.clear();
	runtimeState.nextRootRefIndex = 1;

	const restoredResources = new Set<string>();
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if ((entry as any)?.type !== "message") continue;
		const message = (entry as any).message;
		if (!message || message.role !== "toolResult") continue;
		if (!AGENT_TOOL_NAMES.has(message.toolName)) continue;

		const rawDetails = message.details as any;
		if (rawDetails?.tool === "find_roots" && Array.isArray(rawDetails.windows)) {
			for (const window of rawDetails.windows) {
				if (typeof window?.windowRef !== "string" || !Number.isFinite(window?.pid)) continue;
				const record: WindowRefRecord = {
					ref: window.windowRef,
					appName: typeof window.app === "string" ? window.app : "Unknown App",
					bundleId: typeof window.bundleId === "string" ? window.bundleId : undefined,
					pid: Math.trunc(window.pid),
					windowTitle: typeof window.windowTitle === "string" ? window.windowTitle : "(untitled)",
					windowId: Number.isFinite(window.windowId) ? Math.trunc(window.windowId) : undefined,
					nativeWindowRef: typeof window.nativeWindowRef === "string" ? window.nativeWindowRef : undefined,
					framePoints: {
						x: toFiniteNumber(window.framePoints?.x, 0),
						y: toFiniteNumber(window.framePoints?.y, 0),
						w: Math.max(1, toFiniteNumber(window.framePoints?.w, 1)),
						h: Math.max(1, toFiniteNumber(window.framePoints?.h, 1)),
					},
					scaleFactor: Math.max(1, toFiniteNumber(window.scaleFactor, 1)),
					isMinimized: toBoolean(window.isMinimized),
					isOnscreen: toBoolean(window.isOnscreen),
					isMain: toBoolean(window.isMain),
					isFocused: toBoolean(window.isFocused),
				};
				runtimeState.windowRefs.set(record.ref, record);
				runtimeState.windowRefByIdentity.set(windowRecordIdentity(record), record.ref);
				const match = /^@r(\d+)$/.exec(record.ref);
				if (match) runtimeState.nextRootRefIndex = Math.max(runtimeState.nextRootRefIndex, Number(match[1]) + 1);
			}
			continue;
		}

		const details = rawDetails as Partial<ComputerUseDetails> | undefined;
		if (!details?.target || !details?.capture) continue;

		const app = typeof details.target.app === "string" ? details.target.app : undefined;

		if (!app) continue;
		if (!Number.isFinite(details.target.pid) || !Number.isFinite(details.target.windowId)) continue;
		if (typeof details.capture.stateId !== "string") continue;

		const target: CurrentTarget = {
			appName: app,
			bundleId: details.target.bundleId,
			pid: Math.trunc(details.target.pid),
			windowTitle: details.target.windowTitle ?? "(untitled)",
			windowId: Math.trunc(details.target.windowId),
			windowRef: typeof details.target.windowRef === "string" ? details.target.windowRef : undefined,
			nativeWindowRef: typeof (details.target as any).nativeWindowRef === "string" ? (details.target as any).nativeWindowRef : undefined,
		};

		const resourceKey = desktopResourceKey(target);
		if (restoredResources.has(resourceKey)) continue;
		const capture: CurrentCapture = {
			stateId: details.capture.stateId,
			width: Math.max(1, Math.trunc(toFiniteNumber(details.capture.width, 1))),
			height: Math.max(1, Math.trunc(toFiniteNumber(details.capture.height, 1))),
			scaleFactor: Math.max(1, toFiniteNumber(details.capture.scaleFactor, 1)),
			timestamp: Number.isFinite(details.capture.timestamp) ? details.capture.timestamp : Date.now(),
		};
		if (details.outline?.root && typeof details.outline.lookId === "string") {
			const epoch = 0;
			resourceScheduler.restoreEpoch(resourceKey, epoch);
			savedStates.set({
				stateId: capture.stateId,
				resourceKey,
				epoch,
				value: {
					kind: "desktop",
					target,
					capture,
					outline: details.outline,
					look: {
				lookId: details.outline.lookId,
				capturedAt: details.capture.timestamp / 1000,
				window: {
					windowId: Math.trunc(details.target.windowId),
					framePoints: { x: 0, y: 0, w: details.capture.width, h: details.capture.height },
					scaleFactor: details.capture.scaleFactor,
					isModal: false,
					role: "",
					subrole: "",
				},
				image: { jpegBase64: "", width: details.capture.width, height: details.capture.height },
				timings: {},
					},
					note: details.note,
				},
			});
			restoredResources.add(resourceKey);
		}
	}
}
