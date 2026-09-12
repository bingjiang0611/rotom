// Opt-in experiment: one task over public Pi RPC, never a second scheduler.
import type { Writable } from "node:stream";
export const STARTUP_GATE_ENV = "PI_SUBAGENT_STARTUP_GATE";
export const STARTUP_TOKEN_ENV = "PI_SUBAGENT_STARTUP_TOKEN";
export const STARTUP_STATUS_PREFIX = "subagent-startup/";
export const STARTUP_READY = "ready:v1";
export const STARTUP_TOKEN =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function createStartupTransport(input: {
	stdin: Pick<Writable, "write" | "on">;
	token: string;
	task: string;
	fail: (message: string) => void;
	timeoutMs?: number;
}) {
	let ready = false,
		idle = false,
		dispatched = false,
		settled = false,
		failed = false,
		disposed = false,
		started = false,
		probed = false;
	const stateId = `${input.token}/state`,
		promptId = `${input.token}/prompt`;
	const task = input.task;
	const prompt = { id: promptId, type: "prompt", message: `Task: ${task}` };
	const fail = () => {
		if (failed || disposed) return;
		failed = true;
		clearTimeout(timer);
		input.fail(
			dispatched
				? "Subagent RPC transport unconfirmed after task dispatch; execution and side effects unknown. Do not retry automatically."
				: "Subagent startup unconfirmed; task not dispatched. Child termination must still be verified.",
		);
	};
	const timer = setTimeout(fail, input.timeoutMs ?? 10000);
	timer.unref?.();
	const send = (value: unknown) => {
		try {
			input.stdin.write(
				JSON.stringify(value) + "\n",
				(error?: Error | null) => {
					if (error) fail();
				},
			);
		} catch {
			fail();
		}
	};
	// Keep a harmless listener for late pipe errors; disposal cannot turn EPIPE into a crash.
	input.stdin.on("error", fail);
	const probe = () => {
		if (!started || !ready || probed || failed || disposed) return;
		probed = true;
		send({ id: stateId, type: "get_state" });
	};
	const dispatch = () => {
		if (!ready || !idle || dispatched || failed || disposed) return;
		// Mark before write: a write failure does not prove that no bytes were consumed.
		dispatched = true;
		clearTimeout(timer);
		send(prompt);
	};
	return {
		start() {
			if (started || disposed || failed) return;
			started = true;
			if (
				!STARTUP_TOKEN.test(input.token) ||
				Buffer.byteLength(task) > 1024 * 1024 ||
				Buffer.byteLength(JSON.stringify(prompt)) > 1024 * 1024
			) {
				fail();
				return;
			}
			probe();
		},
		record(value: unknown): boolean {
			if (!value || typeof value !== "object" || Array.isArray(value))
				return false;
			const e = value as Record<string, unknown>;
			const data =
				e.data && typeof e.data === "object"
					? (e.data as Record<string, unknown>)
					: {};
			if (disposed || failed) return true;
			if (e.type === "response") {
				if (e.id === stateId) {
					if (
						!probed ||
						e.command !== "get_state" ||
						e.success !== true ||
						data.isStreaming !== false ||
						data.isCompacting !== false ||
						data.pendingMessageCount !== 0
					)
						fail();
					else {
						idle = true;
						dispatch();
					}
				} else if (
					e.id === promptId &&
					(e.command !== "prompt" || e.success !== true)
				)
					fail();
				return true;
			}
			if (e.type === "extension_ui_request") {
				if (
					e.method === "setStatus" &&
					e.statusKey === STARTUP_STATUS_PREFIX + input.token
				) {
					if (e.statusText !== STARTUP_READY) fail();
					else {
						ready = true;
						probe();
					}
				} else if (
					typeof e.method === "string" &&
					["select", "confirm", "input", "editor"].includes(e.method)
				)
					fail();
				return true;
			}
			if (e.type === "extension_error") {
				fail();
				return true;
			}
			if (e.type === "agent_start" || e.type === "tool_execution_start") {
				if (!dispatched) {
					fail();
					return true;
				}
				settled = false;
			}
			if (e.type === "agent_settled") {
				if (!dispatched) {
					fail();
					return true;
				}
				settled = true;
			}
			return false;
		},
		closed() {
			if (!settled) fail();
			this.dispose();
		},
		dispose() {
			disposed = true;
			clearTimeout(timer);
		},
	};
}
