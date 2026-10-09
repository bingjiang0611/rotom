import { readFileSync, rmSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type BashToolOutput, createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool } from "../src/core/tools/edit.ts";

const logs = new Set<string>();
afterEach(() => {
	for (const path of logs) rmSync(path, { force: true });
	logs.clear();
});

function shell(output: string, exitCode = 0, failure?: string) {
	return createBashTool(process.cwd(), {
		operations: {
			async exec(_command, _cwd, { onData }) {
				onData(Buffer.from(output));
				if (failure) throw new Error(failure);
				return { exitCode };
			},
		},
	});
}

function text(result: { content: { type: string; text?: string }[] }) {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("compact shell output", () => {
	it("bounds direct and programmatic output identically and preserves the complete log", async () => {
		const original = Array.from({ length: 1000 }, (_, i) => `${i}: fixture output`).join("\n");
		const result = await shell(original).execute("compact", { command: "fixture", compact: true });
		const data = result.structuredContent as BashToolOutput;
		expect(data.exit_code).toBe(0);
		expect(data.truncated).toBe(true);
		expect(data.output.split("\n")).toHaveLength(80);
		expect(data.output).toBe(original.split("\n").slice(-80).join("\n"));
		expect(text(result)).toContain(data.output);
		expect(text(result)).toContain("Showing lines 921-1000 of 1000");
		expect(text(result)).toContain(data.full_output_path);
		logs.add(data.full_output_path!);
		expect(readFileSync(data.full_output_path!, "utf8")).toBe(original);
		expect(statSync(data.full_output_path!).mode & 0o077).toBe(0);
	});

	it("does not launder failed checks or discard a failure outside the excerpt", async () => {
		const original = `ERROR: exact failure evidence\n${"noise\n".repeat(1000)}final status\n`;
		const result = await shell(original, 7).execute("failure", { command: "fixture", compact: true });
		const data = result.structuredContent as BashToolOutput;
		expect(result.isError).toBe(true);
		expect(data.exit_code).toBe(7);
		expect(text(result)).toContain("Command exited with code 7");
		expect(data.output).not.toContain("exact failure evidence");
		logs.add(data.full_output_path!);
		expect(readFileSync(data.full_output_path!, "utf8")).toBe(original);
	});

	it("enforces the byte limit without breaking UTF-8", async () => {
		const result = await shell("中文".repeat(10000)).execute("bytes", { command: "fixture", compact: true });
		const data = result.structuredContent as BashToolOutput;
		logs.add(data.full_output_path!);
		expect(Buffer.byteLength(data.output)).toBeLessThanOrEqual(8192);
		expect(data.output).not.toContain("\uFFFD");
		expect(data.truncated).toBe(true);
		expect(readFileSync(data.full_output_path!, "utf8")).toBe("中文".repeat(10000));
	});

	it.each(["", "small result\n"])("retains complete small output %j", async (original) => {
		const result = await shell(original).execute("small", { command: "fixture", compact: true });
		expect(result.structuredContent).toMatchObject({ output: original, truncated: false, exit_code: 0 });
		expect((result.structuredContent as BashToolOutput).full_output_path).toBeUndefined();
	});

	it("leaves the default programmatic contract unchanged", async () => {
		const original = "x".repeat(60000);
		const result = await shell(original).execute("default", { command: "fixture" });
		logs.add((result.details as { fullOutputPath: string }).fullOutputPath);
		expect(result.structuredContent).toMatchObject({ output: original, truncated: false });
	});

	it.each(["timeout:1", "aborted"])("retains the log for %s without claiming a completed exit", async (failure) => {
		let error: Error | undefined;
		try {
			await shell("noise\n".repeat(1000), 0, failure).execute("interrupted", { command: "fixture", compact: true });
		} catch (caught) {
			error = caught as Error;
		}
		expect(error).toBeInstanceOf(Error);
		const path = /Full output: (.+)\]/u.exec(error!.message)?.[1];
		expect(path).toBeTruthy();
		logs.add(path!);
		expect(readFileSync(path!, "utf8")).toBe("noise\n".repeat(1000));
		expect(error!.message).not.toContain("Command exited with code 0");
	});
});

describe("edit rejection receipt", () => {
	it("rejects the entire batch before writing when a later block is ambiguous", async () => {
		let writes = 0;
		const tool = createEditTool(process.cwd(), {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from("unique\nduplicate\nduplicate\n"),
				writeFile: async () => {
					writes++;
				},
			},
		});
		await expect(
			tool.execute("reject", {
				path: "fixture.txt",
				edits: [
					{ oldText: "unique", newText: "changed" },
					{ oldText: "duplicate", newText: "other" },
				],
			}),
		).rejects.toThrow(/edits\[1\][\s\S]*No edits were written by this call/u);
		expect(writes).toBe(0);
	});

	it("does not claim no write when the writer changed data and then failed", async () => {
		let contents = "old";
		const tool = createEditTool(process.cwd(), {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from(contents),
				writeFile: async (_path, next) => {
					contents = next;
					throw new Error("write acknowledgement lost");
				},
			},
		});
		await expect(
			tool.execute("unknown", { path: "fixture.txt", edits: [{ oldText: "old", newText: "new" }] }),
		).rejects.toThrow(/^write acknowledgement lost$/u);
		expect(contents).toBe("new");
	});
});
