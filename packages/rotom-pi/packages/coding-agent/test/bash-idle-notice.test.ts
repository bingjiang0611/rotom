import { tmpdir } from "node:os";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { type BashOperations, type BashToolDetails, createBashToolDefinition } from "../src/core/tools/bash.ts";
import type { BashIdleNotice } from "../src/core/tools/bash-idle-notice.ts";
import { formatIdleNotice } from "../src/core/tools/renderers/bash.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { parseProcessTree } from "../src/utils/shell.ts";

/**
 * A command whose child blocked on a native modal dialog (Electron's "Error launching app") kept a turn
 * running for hours with nothing on screen: bash has no default timeout and the dialog is invisible from
 * the terminal. After a stretch of silence the tool now tells the UI which processes are still running.
 * It does not kill anything, and the model never sees the notice.
 */

type Update = { content: Array<{ type: string; text?: string }>; details?: BashToolDetails };

async function run(command: string, idleNoticeSeconds: number, operations?: BashOperations) {
	const updates: Update[] = [];
	const tool = createBashToolDefinition(tmpdir(), {
		exposeSessionEnvironment: false,
		idleNoticeSeconds,
		...(operations ? { operations } : {}),
	});
	const result = await tool.execute(
		"idle-notice",
		{ command },
		undefined,
		(update) => updates.push(update as Update),
		{} as never,
	);
	return { updates, result, idleUpdates: updates.filter((update) => update.details?.idle) };
}

describe("parseProcessTree", () => {
	it("returns the root, its descendants breadth-first and orphaned group members, by executable basename", () => {
		const ps = [
			"    1     0     1 /sbin/launchd",
			"  100     1   100 bash",
			"  101   100   100 /usr/local/bin/node",
			"  102   101   100 /Applications/Electron.app/Contents/MacOS/Electron",
			"  103   100   100 tail",
			"  104     1   100 Helper With Spaces",
			"  200     1   200 unrelated",
			"garbage line",
		].join("\n");
		expect(parseProcessTree(ps, 100)).toEqual([
			{ pid: 100, name: "bash" },
			{ pid: 101, name: "node" },
			{ pid: 103, name: "tail" },
			{ pid: 102, name: "Electron" },
			{ pid: 104, name: "Helper With Spaces" },
		]);
		expect(parseProcessTree(ps, 999)).toEqual([]);
	});
});

describe.skipIf(process.platform === "win32")("bash idle notice", () => {
	it("reports the silent child process to the UI but not in the result", async () => {
		const { idleUpdates, result } = await run("sleep 1.2", 0.3);
		expect(idleUpdates.length).toBeGreaterThan(0);
		const idle = idleUpdates.at(-1)!.details!.idle!;
		expect(idle.seconds).toBeGreaterThanOrEqual(0);
		expect(idle.processes?.some((entry) => entry.name === "sleep")).toBe(true);
		expect(result.details?.idle).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
	});

	it("clears the notice when output resumes", async () => {
		const { updates, idleUpdates } = await run("sleep 0.8; echo resumed; sleep 0.1", 0.3);
		expect(idleUpdates.length).toBeGreaterThan(0);
		const resumed = updates.find((update) => update.content[0]?.text?.includes("resumed"));
		expect(resumed).toBeDefined();
		expect(resumed!.details?.idle).toBeUndefined();
	});

	it("stays quiet when disabled", async () => {
		const { idleUpdates } = await run("sleep 0.5", 0);
		expect(idleUpdates).toEqual([]);
	});

	it("omits the process list for backends that do not report a pid", async () => {
		const operations: BashOperations = {
			exec: () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0 }), 500)),
		};
		const { idleUpdates } = await run("remote", 0.2, operations);
		expect(idleUpdates.length).toBeGreaterThan(0);
		expect(idleUpdates[0].details!.idle!.processes).toBeUndefined();
	});
});

describe("bash idle notice rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const idle: BashIdleNotice = {
		seconds: 125,
		processes: [
			{ pid: 1, name: "a" },
			{ pid: 2, name: "b" },
			{ pid: 3, name: "c" },
			{ pid: 4, name: "node" },
			{ pid: 5, name: "Electron" },
		],
	};

	it("keeps the deepest processes and names the interrupt key", () => {
		expect(formatIdleNotice(idle, "esc")).toBe(
			"No output for 2m 5s. Still running: +1 more, b (2), c (3), node (4), Electron (5). If it waits for a dialog or input this terminal cannot show, esc interrupts it.",
		);
		expect(formatIdleNotice({ seconds: 61 }, "esc")).toBe(
			"No output for 1m 1s. If it waits for a dialog or input this terminal cannot show, esc interrupts it.",
		);
	});

	it("shows the notice only while the command is running", () => {
		const tool = createBashToolDefinition(tmpdir(), { exposeSessionEnvironment: false });
		const component = new ToolExecutionComponent(
			"bash",
			"idle-render",
			{ command: "electron -e x" },
			{},
			tool,
			{ requestRender: () => {} } as unknown as TUI,
			tmpdir(),
		);
		component.updateResult({ content: [], details: { idle }, isError: false }, true);
		expect(stripAnsi(component.render(200).join("\n"))).toContain(
			"Still running: +1 more, b (2), c (3), node (4), Electron (5).",
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: { idle }, isError: false }, false);
		expect(stripAnsi(component.render(200).join("\n"))).not.toContain("No output for");
	});
});
