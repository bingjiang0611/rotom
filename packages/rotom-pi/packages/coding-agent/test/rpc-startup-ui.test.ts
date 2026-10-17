import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

const io = vi.hoisted(() => ({
	lines: [] as Record<string, unknown>[],
	input: undefined as ((line: string) => void) | undefined,
	detach: vi.fn(),
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		io.lines.push(JSON.parse(line));
	},
}));
vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));
vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, listener: (line: string) => void) => {
		io.input = listener;
		return io.detach;
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

describe("RPC startup extension UI", () => {
	const listeners = (["SIGTERM", "SIGHUP"] as const).map((event) => ({ event, original: process.listeners(event) }));
	const inputEndListeners = process.stdin.listeners("end");

	afterEach(() => {
		for (const { event, original } of listeners) {
			for (const listener of process.listeners(event))
				if (!original.includes(listener)) process.off(event, listener);
		}
		for (const listener of process.stdin.listeners("end")) {
			if (!inputEndListeners.includes(listener)) process.stdin.off("end", listener as () => void);
		}
		io.lines = [];
		io.input = undefined;
		io.detach.mockClear();
	});

	it("detaches input and signal handlers when extension initialization fails", async () => {
		const failure = new Error("Extension startup failed");
		const host = {
			session: {
				bindExtensions: vi.fn(async () => {
					throw failure;
				}),
			},
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		await expect(runRpcMode(host)).rejects.toBe(failure);
		expect(io.detach).toHaveBeenCalledTimes(1);
		expect(process.stdin.listeners("end")).toEqual(inputEndListeners);
		for (const { event, original } of listeners) expect(process.listeners(event)).toEqual(original);
	});

	it.each([false, true])("handles a startup dialog (cancelled=%s) before ordinary commands", async (cancelled) => {
		let selection: string | undefined;
		let initialized = false;
		const agent = new Agent({
			streamFn: () => {
				throw new Error("Startup must not call a model");
			},
		});
		const getCommands = vi.fn(() => {
			expect(initialized).toBe(true);
			return [];
		});
		const session = {
			agent,
			bindExtensions: async ({ uiContext }: { uiContext: ExtensionUIContext }) => {
				selection = await uiContext.select("Optional setup", ["Stay offline"]);
				initialized = true;
			},
			subscribe: vi.fn(() => () => {}),
			extensionRunner: { getRegisteredCommands: getCommands },
			promptTemplates: [],
			resourceLoader: { getSkills: () => ({ skills: [] }) },
		};
		const host = { session, setRebindSession: vi.fn() } as unknown as AgentSessionRuntime;
		void runRpcMode(host);
		await vi.waitFor(() =>
			expect(io.lines).toContainEqual(expect.objectContaining({ type: "extension_ui_request", method: "select" })),
		);
		// This fails on the old initialization order without waiting for a timeout.
		expect(io.input).toBeTypeOf("function");
		const dialog = io.lines.find((line) => line.type === "extension_ui_request")!;
		io.input!(JSON.stringify({ id: "catalog", type: "get_commands" }));
		io.input!("invalid json");
		await vi.waitFor(() =>
			expect(io.lines).toContainEqual(expect.objectContaining({ command: "parse", success: false })),
		);
		expect(getCommands).not.toHaveBeenCalled();
		expect(io.lines.some((line) => line.id === "catalog")).toBe(false);
		io.input!(
			JSON.stringify({
				type: "extension_ui_response",
				id: dialog.id,
				...(cancelled ? { cancelled: true } : { value: "Stay offline" }),
			}),
		);
		await vi.waitFor(() =>
			expect(io.lines).toContainEqual(expect.objectContaining({ id: "catalog", success: true })),
		);
		expect(selection).toBe(cancelled ? undefined : "Stay offline");
		expect(getCommands).toHaveBeenCalledTimes(1);
	});
});
