import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
	type RunnerTestCase,
	recordArtifact,
	type TestArtifact,
	type TestArtifactBase,
	type TestAttachment,
} from "vitest";
import type { HarnessRun } from "vitest-evals/harness";

export const PI_SESSION_SNAPSHOT_ARTIFACT = "piSessionJsonl";
export const PI_TRACE_SNAPSHOT_ARTIFACT = "piTraceJsonl";
export const PI_TRACE_SNAPSHOT_METADATA_ARTIFACT = "piTraceSnapshot";
export const MAX_EVAL_TRACE_SNAPSHOT_BYTES = 1024 * 1024;
export const EVAL_TRACE_SNAPSHOT_SCHEMA_V1 = "dev-agent-eval-trace-snapshot/v1";

export type EvalTraceSnapshotMetadataV1 = {
	schema: typeof EVAL_TRACE_SNAPSHOT_SCHEMA_V1;
	originalBytes: number;
	capturedBytes: number;
	truncated: boolean;
	strategy: "full" | "tail";
};

const evalSessionArtifactKey = Symbol("dev-agent-evals-session-artifact");
const evalTraceArtifactKey = Symbol("dev-agent-evals-trace-artifact");
const evalSourceArtifactKey = Symbol("dev-agent-evals-source-artifact");

interface PiSessionAttachment extends TestAttachment {
	name: "session.jsonl";
	contentType: "application/jsonl";
	body: string;
	bodyEncoding: "utf-8";
}

export interface SourceAttachment extends TestAttachment {
	name: string;
	contentType: string;
	body: string;
	bodyEncoding: "utf-8";
}

interface PiSessionArtifact extends TestArtifactBase {
	type: "dev-agent-evals:session";
	runId: string;
	attachments: [PiSessionAttachment] | [];
}

interface PiTraceArtifact extends TestArtifactBase {
	type: "dev-agent-evals:trace";
	runId: string;
	attachments: [
		TestAttachment & {
			name: "trace.jsonl";
			contentType: "application/jsonl";
			body: string;
			bodyEncoding: "utf-8";
		},
		TestAttachment & {
			name: "trace-snapshot.json";
			contentType: "application/json";
			body: string;
			bodyEncoding: "utf-8";
		},
	] | [];
}

interface SourceArtifact extends TestArtifactBase {
	type: "dev-agent-evals:source";
	runId: string;
	attachments: [SourceAttachment] | [];
}

declare module "vitest" {
	interface TestArtifactRegistry {
		[evalSessionArtifactKey]: PiSessionArtifact;
		[evalTraceArtifactKey]: PiTraceArtifact;
		[evalSourceArtifactKey]: SourceArtifact;
	}
}

function tracePathForSessionFile(sessionPath: string): string {
	const stem = basename(sessionPath).replace(/\.jsonl$/u, "");
	return join(dirname(sessionPath), "observability", `${stem}.trace.jsonl`);
}

function assertContained(root: string, candidate: string, description: string): void {
	const nested = relative(root, candidate);
	if (nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))) return;
	throw new Error(`${description} escaped its private root.`);
}

export async function ensurePrivateEvalArtifactDirectory(path: string, canonicalRoot?: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
		throw new Error(`Eval artifact directory is not private: ${path}`);
	}
	const canonical = await realpath(path);
	if (canonicalRoot) assertContained(canonicalRoot, canonical, "Eval artifact directory");
	return canonical;
}

export async function writePrivateEvalArtifactFile(path: string, body: string, mode: "append" | "replace" = "replace"): Promise<void> {
	const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (existing && (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)) {
		throw new Error(`Eval artifact path is not a private regular file: ${path}`);
	}
	const writeFlag = mode === "append" ? constants.O_APPEND : constants.O_TRUNC;
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | writeFlag | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		const info = await handle.stat();
		if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`Eval artifact path is not a private regular file: ${path}`);
		await handle.writeFile(body, { encoding: "utf8" });
	} finally {
		await handle.close();
	}
}

async function readExactly(
	handle: Awaited<ReturnType<typeof open>>,
	length: number,
	position: number,
): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}

export async function captureEvalTraceSnapshot(
	sessionPath: string,
	maximumBytes = MAX_EVAL_TRACE_SNAPSHOT_BYTES,
): Promise<{ body: string; metadata: EvalTraceSnapshotMetadataV1 } | undefined> {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
		throw new TypeError("maximumBytes must be a positive safe integer.");
	}
	const tracePath = tracePathForSessionFile(sessionPath);
	const traceDirectory = dirname(tracePath);
	const directoryInfo = await lstat(traceDirectory).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!directoryInfo) return undefined;
	if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0) {
		throw new Error("Pi eval trace directory must be private and non-symlinked.");
	}
	const expected = await lstat(tracePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!expected) return undefined;
	if (!expected.isFile() || expected.isSymbolicLink() || (expected.mode & 0o077) !== 0) {
		throw new Error("Pi eval trace must be a private regular file.");
	}
	const canonicalSessionDirectory = await realpath(dirname(sessionPath));
	const canonicalTrace = await realpath(tracePath);
	assertContained(canonicalSessionDirectory, canonicalTrace, "Pi eval trace");
	const handle = await open(tracePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const file = await handle.stat();
		if (!file.isFile() || file.dev !== expected.dev || file.ino !== expected.ino || (file.mode & 0o077) !== 0) {
			throw new Error("Pi eval trace must be a stable private regular file.");
		}
		const originalBytes = file.size;
		const truncated = originalBytes > maximumBytes;
		const strategy = truncated ? "tail" : "full";
		const position = truncated ? originalBytes - maximumBytes : 0;
		let content = await readExactly(handle, Math.min(originalBytes, maximumBytes), position);
		if (truncated) {
			const previous = await readExactly(handle, 1, position - 1);
			if (previous[0] !== 0x0a) {
				const firstNewline = content.indexOf(0x0a);
				content = firstNewline === -1 ? Buffer.alloc(0) : content.subarray(firstNewline + 1);
			}
		}
		return {
			body: content.toString("utf8"),
			metadata: {
				schema: EVAL_TRACE_SNAPSHOT_SCHEMA_V1,
				originalBytes,
				capturedBytes: content.byteLength,
				truncated,
				strategy,
			},
		};
	} finally {
		await handle.close();
	}
}

export async function recordEvalRunArtifacts(
	task: Readonly<RunnerTestCase>,
	run: Pick<HarnessRun, "artifacts">,
): Promise<void> {
	const runId = run.artifacts?.runId;
	const session = run.artifacts?.[PI_SESSION_SNAPSHOT_ARTIFACT];
	const trace = run.artifacts?.[PI_TRACE_SNAPSHOT_ARTIFACT];
	const traceMetadata = run.artifacts?.[PI_TRACE_SNAPSHOT_METADATA_ARTIFACT];
	if (session === undefined && trace === undefined && traceMetadata === undefined) return;
	if (typeof runId !== "string") throw new TypeError("Pi eval artifact run id is invalid.");
	if (session !== undefined) {
		if (typeof session !== "string") throw new TypeError("Pi eval session artifact metadata is invalid.");
		await recordArtifact(task, {
			type: "dev-agent-evals:session",
			runId,
			attachments: [
				{
					name: "session.jsonl",
					contentType: "application/jsonl",
					body: session,
					bodyEncoding: "utf-8",
				},
			],
		});
	}
	if (trace !== undefined || traceMetadata !== undefined) {
		if (typeof trace !== "string" || !traceMetadata || typeof traceMetadata !== "object" || Array.isArray(traceMetadata)) {
			throw new TypeError("Pi eval trace artifact metadata is invalid.");
		}
		const parsedMetadata = traceMetadata as EvalTraceSnapshotMetadataV1;
		const traceBytes = Buffer.byteLength(trace, "utf8");
		if (
			traceBytes > MAX_EVAL_TRACE_SNAPSHOT_BYTES ||
			parsedMetadata.schema !== EVAL_TRACE_SNAPSHOT_SCHEMA_V1 ||
			!Number.isSafeInteger(parsedMetadata.originalBytes) || parsedMetadata.originalBytes < 0 ||
			!Number.isSafeInteger(parsedMetadata.capturedBytes) || parsedMetadata.capturedBytes !== traceBytes ||
			typeof parsedMetadata.truncated !== "boolean" ||
			(parsedMetadata.strategy !== "full" && parsedMetadata.strategy !== "tail") ||
			(!parsedMetadata.truncated && (parsedMetadata.strategy !== "full" || parsedMetadata.originalBytes !== traceBytes)) ||
			(parsedMetadata.truncated && (parsedMetadata.strategy !== "tail" || parsedMetadata.originalBytes <= traceBytes))
		) {
			throw new TypeError("Pi eval trace artifact metadata is invalid.");
		}
		await recordArtifact(task, {
			type: "dev-agent-evals:trace",
			runId,
			attachments: [
				{
					name: "trace.jsonl",
					contentType: "application/jsonl",
					body: trace,
					bodyEncoding: "utf-8",
				},
				{
					name: "trace-snapshot.json",
					contentType: "application/json",
					body: `${JSON.stringify(parsedMetadata, null, 2)}\n`,
					bodyEncoding: "utf-8",
				},
			],
		});
	}
}

export async function recordEvalSourceArtifact(
	task: Readonly<RunnerTestCase>,
	runId: string,
	attachment: SourceAttachment,
): Promise<void> {
	await recordArtifact(task, {
		type: "dev-agent-evals:source",
		runId,
		attachments: [attachment],
	});
}

export async function persistEvalArtifactReferences(
	artifacts: ReadonlyArray<TestArtifact>,
	runId: string,
	artifactDirectory: string,
): Promise<Array<{ name: string; path: string }>> {
	const references: Array<{ name: string; path: string }> = [];
	const canonicalArtifactRoot = await ensurePrivateEvalArtifactDirectory(artifactDirectory);
	for (const artifact of artifacts) {
		if (
			(artifact.type !== "dev-agent-evals:session" &&
				artifact.type !== "dev-agent-evals:trace" &&
				artifact.type !== "dev-agent-evals:source") ||
			artifact.runId !== runId
		) {
			continue;
		}
		const category = artifact.type === "dev-agent-evals:session"
			? "sessions"
			: artifact.type === "dev-agent-evals:trace"
				? "traces"
				: "sources";
		const categoryDirectory = join(artifactDirectory, category);
		await ensurePrivateEvalArtifactDirectory(categoryDirectory, canonicalArtifactRoot);
		const directory = join(categoryDirectory, createHash("sha256").update(runId).digest("hex"));
		const canonicalRunDirectory = await ensurePrivateEvalArtifactDirectory(directory, canonicalArtifactRoot);
		for (const attachment of artifact.attachments) {
			const name = basename(attachment.name);
			if (name !== attachment.name) throw new TypeError(`Invalid eval artifact name: ${attachment.name}`);
			if (artifact.type === "dev-agent-evals:trace" && name === "trace.jsonl" && Buffer.byteLength(attachment.body, "utf8") > MAX_EVAL_TRACE_SNAPSHOT_BYTES) {
				throw new TypeError("Pi eval trace artifact exceeds the bounded snapshot limit.");
			}
			const path = join(directory, name);
			assertContained(canonicalRunDirectory, join(canonicalRunDirectory, name), "Eval artifact path");
			await writePrivateEvalArtifactFile(path, attachment.body);
			references.push({ name, path: relative(artifactDirectory, path) });
		}
	}
	return references;
}
