import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	captureEvalTraceSnapshot,
	ensurePrivateEvalArtifactDirectory,
	EVAL_TRACE_SNAPSHOT_SCHEMA_V1,
	MAX_EVAL_TRACE_SNAPSHOT_BYTES,
	persistEvalArtifactReferences,
	writePrivateEvalArtifactFile,
	recordEvalRunArtifacts,
	recordEvalSourceArtifact,
} from "../../src/vitest-evals/artifacts.ts";

it("captures a private trace after shutdown and retains complete tail records when bounded", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-eval-trace-snapshot-test-"));
	const sessionPath = join(root, "session-1.jsonl");
	const traceDirectory = join(root, "observability");
	const tracePath = join(traceDirectory, "session-1.trace.jsonl");
	try {
		await writeFile(sessionPath, "session\n", { mode: 0o600 });
		await mkdir(traceDirectory, { mode: 0o700 });
		const first = '{"kind":"span_start"}\n';
		const terminal = '{"kind":"span_end","shutdown":"quit"}\n';
		await writeFile(tracePath, first + terminal, { mode: 0o600 });

		const full = await captureEvalTraceSnapshot(sessionPath);
		expect(full).toEqual({
			body: first + terminal,
			metadata: {
				schema: EVAL_TRACE_SNAPSHOT_SCHEMA_V1,
				originalBytes: Buffer.byteLength(first + terminal),
				capturedBytes: Buffer.byteLength(first + terminal),
				truncated: false,
				strategy: "full",
			},
		});

		const exactTail = await captureEvalTraceSnapshot(sessionPath, Buffer.byteLength(terminal));
		expect(exactTail?.body).toBe(terminal);
		const tail = await captureEvalTraceSnapshot(sessionPath, Buffer.byteLength(terminal) + 3);
		expect(tail?.body).toBe(terminal);
		expect(tail?.metadata).toEqual(expect.objectContaining({
			originalBytes: Buffer.byteLength(first + terminal),
			capturedBytes: Buffer.byteLength(terminal),
			truncated: true,
			strategy: "tail",
		}));

		await chmod(tracePath, 0o644);
		await expect(captureEvalTraceSnapshot(sessionPath)).rejects.toThrow("private regular file");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects symlinked trace parents and symlinked or permissive artifact sinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-eval-artifact-safety-test-"));
	try {
		const sessionRoot = join(root, "session-root");
		const outsideTrace = join(root, "outside-trace");
		await mkdir(sessionRoot, { mode: 0o700 });
		await mkdir(outsideTrace, { mode: 0o700 });
		const sessionPath = join(sessionRoot, "session.jsonl");
		await writeFile(sessionPath, "session\n", { mode: 0o600 });
		await writeFile(join(outsideTrace, "session.trace.jsonl"), "{}\n", { mode: 0o600 });
		await symlink(outsideTrace, join(sessionRoot, "observability"));
		await expect(captureEvalTraceSnapshot(sessionPath)).rejects.toThrow("directory must be private");

		const realArtifacts = join(root, "real-artifacts");
		const linkedArtifacts = join(root, "linked-artifacts");
		await mkdir(realArtifacts, { mode: 0o700 });
		await symlink(realArtifacts, linkedArtifacts);
		await expect(persistEvalArtifactReferences([], "run-1", linkedArtifacts)).rejects.toThrow("not private");

		const permissiveArtifacts = join(root, "permissive-artifacts");
		await mkdir(permissiveArtifacts, { mode: 0o755 });
		await expect(persistEvalArtifactReferences([], "run-1", permissiveArtifacts)).rejects.toThrow("not private");

		const safeArtifacts = join(root, "safe-artifacts");
		const artifacts: any[] = [{
			type: "dev-agent-evals:session" as const,
			runId: "run-1",
			attachments: [{ name: "session.jsonl" as const, body: "session\n", bodyEncoding: "utf-8" as const, contentType: "application/jsonl" as const }],
		}];
		await ensurePrivateEvalArtifactDirectory(safeArtifacts);
		const runsPath = join(safeArtifacts, "runs.jsonl");
		await writePrivateEvalArtifactFile(runsPath, "one\n", "append");
		await writePrivateEvalArtifactFile(runsPath, "two\n", "append");
		expect(await readFile(runsPath, "utf8")).toBe("one\ntwo\n");
		await chmod(runsPath, 0o644);
		await expect(writePrivateEvalArtifactFile(runsPath, "three\n", "append")).rejects.toThrow("private regular file");
		await unlink(runsPath);
		const outsideReport = join(root, "outside-report.jsonl");
		await writeFile(outsideReport, "outside\n", { mode: 0o600 });
		await symlink(outsideReport, runsPath);
		await expect(writePrivateEvalArtifactFile(runsPath, "three\n", "append")).rejects.toThrow("private regular file");
		await unlink(runsPath);

		const first = await persistEvalArtifactReferences(artifacts, "run-1", safeArtifacts);
		const output = join(safeArtifacts, first[0].path);
		const outsideOutput = join(root, "outside-output.jsonl");
		await writeFile(outsideOutput, "outside\n", { mode: 0o600 });
		await unlink(output);
		await symlink(outsideOutput, output);
		await expect(persistEvalArtifactReferences(artifacts, "run-1", safeArtifacts)).rejects.toThrow("private regular file");
		await unlink(output);
		await writeFile(output, "permissive\n", { mode: 0o644 });
		await expect(persistEvalArtifactReferences(artifacts, "run-1", safeArtifacts)).rejects.toThrow("private regular file");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects a trace artifact larger than the bounded snapshot contract", async ({ task }) => {
	const trace = "x".repeat(MAX_EVAL_TRACE_SNAPSHOT_BYTES + 1);
	await expect(recordEvalRunArtifacts(task, {
		artifacts: {
			runId: "oversized-run",
			piTraceJsonl: trace,
			piTraceSnapshot: {
				schema: EVAL_TRACE_SNAPSHOT_SCHEMA_V1,
				originalBytes: trace.length + 1,
				capturedBytes: trace.length,
				truncated: true,
				strategy: "tail",
			},
		},
	})).rejects.toThrow("trace artifact metadata is invalid");
});

it("records session, trace, and source artifacts against the explicit test task", async ({ task }) => {
	const runId = "run-1";
	await recordEvalRunArtifacts(task, {
		artifacts: {
			runId,
			piSessionJsonl: '{"type":"session"}\n',
			piTraceJsonl: '{"schema":"rotom-local-trace/v1","kind":"span_end"}\n',
			piTraceSnapshot: {
				schema: EVAL_TRACE_SNAPSHOT_SCHEMA_V1,
				originalBytes: 55,
				capturedBytes: 55,
				truncated: false,
				strategy: "full",
			},
		},
	});
	await recordEvalSourceArtifact(task, runId, {
		name: "hello.ts",
		contentType: "text/typescript",
		body: "export default function () {}\n",
		bodyEncoding: "utf-8",
	});

	expect(task.artifacts).toContainEqual(
		expect.objectContaining({
			type: "dev-agent-evals:session",
			runId,
			attachments: [
				expect.objectContaining({
					name: "session.jsonl",
					body: '{"type":"session"}\n',
					bodyEncoding: "utf-8",
					contentType: "application/jsonl",
				}),
			],
		}),
	);
	expect(task.artifacts).toContainEqual(
		expect.objectContaining({
			type: "dev-agent-evals:trace",
			runId,
			attachments: [
				expect.objectContaining({
					name: "trace.jsonl",
					body: '{"schema":"rotom-local-trace/v1","kind":"span_end"}\n',
					bodyEncoding: "utf-8",
					contentType: "application/jsonl",
				}),
				expect.objectContaining({
					name: "trace-snapshot.json",
					bodyEncoding: "utf-8",
					contentType: "application/json",
				}),
			],
		}),
	);
	expect(task.artifacts).toContainEqual(
		expect.objectContaining({
			type: "dev-agent-evals:source",
			runId,
			attachments: [
				expect.objectContaining({
					name: "hello.ts",
					body: "export default function () {}\n",
					bodyEncoding: "utf-8",
					contentType: "text/typescript",
				}),
			],
		}),
	);
});

it("persists and selects attachments belonging to the reported run", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-eval-artifact-report-test-"));
	try {
		const references = await persistEvalArtifactReferences(
			[
				{
					type: "dev-agent-evals:session",
					runId: "run-1",
					attachments: [
						{
							name: "session.jsonl",
							body: '{"type":"session"}\n',
							bodyEncoding: "utf-8",
							contentType: "application/jsonl",
						},
					],
				},
				{
					type: "dev-agent-evals:session",
					runId: "run-2",
					attachments: [],
				},
				{
					type: "dev-agent-evals:trace",
					runId: "run-1",
					attachments: [
						{
							name: "trace.jsonl",
							body: '{"kind":"span_end"}\n',
							bodyEncoding: "utf-8",
							contentType: "application/jsonl",
						},
						{
							name: "trace-snapshot.json",
							body: '{"truncated":false}\n',
							bodyEncoding: "utf-8",
							contentType: "application/json",
						},
					],
				},
				{
					type: "dev-agent-evals:source",
					runId: "run-1",
					attachments: [
						{
							name: "hello.ts",
							body: "export default function () {}\n",
							bodyEncoding: "utf-8",
							contentType: "text/typescript",
						},
					],
				},
				{ type: "internal:annotation", annotation: { message: "other", type: "info" } },
			],
			"run-1",
			root,
		);
		expect(references).toEqual([
			{ name: "session.jsonl", path: expect.stringMatching(/^sessions\/[a-f0-9]{64}\/session\.jsonl$/) },
			{ name: "trace.jsonl", path: expect.stringMatching(/^traces\/[a-f0-9]{64}\/trace\.jsonl$/) },
			{ name: "trace-snapshot.json", path: expect.stringMatching(/^traces\/[a-f0-9]{64}\/trace-snapshot\.json$/) },
			{ name: "hello.ts", path: expect.stringMatching(/^sources\/[a-f0-9]{64}\/hello\.ts$/) },
		]);
		const expectedBodies = new Map([
			["session.jsonl", '{"type":"session"}\n'],
			["trace.jsonl", '{"kind":"span_end"}\n'],
			["trace-snapshot.json", '{"truncated":false}\n'],
			["hello.ts", "export default function () {}\n"],
		]);
		for (const { name, path } of references) {
			expect(await readFile(join(root, path), "utf8")).toBe(expectedBodies.get(name));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
