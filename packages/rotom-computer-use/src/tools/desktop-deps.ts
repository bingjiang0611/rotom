import type { BrokerClient } from "../broker/client.ts";
import type { ClientLeaseBroker } from "../broker/lease-broker.ts";
import type { ComputerUseConfig } from "../config.ts";
import type { PlatformRoot } from "../platform/types.ts";
import type { ResourceScheduler } from "../runtime.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { WindowRow } from "./window-types.ts";

/** The broker connection this session holds, when arbitration is on. */
export interface BrokerSession {
	broker: ClientLeaseBroker;
	client: BrokerClient;
}

/**
 * What the administration tools need from the session that owns them.
 *
 * These are getters, not captured values: a session reset replaces the
 * scheduler, the broker and the trace recorder, and a tool must never act on the
 * previous session's write authority. `bridge.ts` owns the wiring and passes
 * this object in, so the tools stay free of hidden session state.
 */
export interface DesktopToolDeps {
	scheduler(): ResourceScheduler;
	trace(): TraceRecorder | undefined;
	broker(): BrokerSession | undefined;
	/** Window rows for native roots; the window ref registry lives in the bridge. */
	collectWindows(roots: PlatformRoot[], config: ComputerUseConfig): WindowRow[];
	formatWindowLine(window: WindowRow): string;
}
