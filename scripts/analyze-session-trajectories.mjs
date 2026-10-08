#!/usr/bin/env node
// Maintenance-only, offline analysis. Never open() a session: it can repair/rewrite JSONL.
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionEntries, SessionManager } from "../packages/rotom-pi/packages/coding-agent/src/core/session-manager.ts";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 32;
const MAX_EXAMPLES = 20;
// Unknown extension tool names may themselves contain private information.
const TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "codemode", "browser_inspect", "browser_interact"]);

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	}
	return value;
}

export function analyzeSession(content) {
	const lines = content.split("\n").flatMap((text, index) => text.trim() ? [index + 1] : []);
	const entries = parseSessionEntries(content);
	// Pi's recovery parser skips malformed lines. Analysis must not silently count a partial corpus.
	if (entries.length !== lines.length) throw new Error("Malformed JSONL; no partial analysis produced");
	const header = entries[0];
	if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string") {
		throw new Error("Only explicit Pi v3 session snapshots are supported");
	}
	const locations = new Map();
	for (let i = 1; i < entries.length; i++) {
		const entry = entries[i];
		// Validate before native traversal: missing parents/cycles would silently truncate or hang it.
		if (!entry || entry.type === "session" || typeof entry.type !== "string" ||
			typeof entry.id !== "string" || !entry.id || locations.has(entry.id) ||
			(entry.parentId !== null && !locations.has(entry.parentId))) {
			throw new Error(`Invalid session tree at line ${lines[i]}`);
		}
		locations.set(entry.id, lines[i]);
	}
	const branch = SessionManager.inMemory(process.cwd(), undefined, entries).getBranch();
	const counts = {
		branchEntries: branch.length, excludedBranchEntries: entries.length - 1 - branch.length,
		messages: 0, userMessages: 0, assistantMessages: 0, compactions: 0, contextEdits: 0,
		topLevelCalls: 0, nestedCalls: 0, nestedCallsWithoutArguments: 0, incompleteNestedRecords: 0,
		toolErrorResults: 0, toolNonErrorResults: 0, unmatchedToolResults: 0, callsWithoutResult: 0,
		assistantErrors: 0, assistantAborts: 0, repeatedCalls: 0, repeatsAcrossCompaction: 0,
	};
	const byTool = {};
	const seen = new Map();
	const pending = new Set();
	const examples = [];
	let epoch = 0;
	function call(name, args, location, nested) {
		counts[nested ? "nestedCalls" : "topLevelCalls"]++;
		const tool = TOOL_NAMES.has(name) ? name : "other";
		byTool[tool] = (byTool[tool] ?? 0) + 1;
		if (args === undefined) { counts.nestedCallsWithoutArguments++; return; }
		const key = JSON.stringify([name, canonical(args)]);
		const prior = seen.get(key);
		if (prior) {
			counts.repeatedCalls++;
			const acrossCompaction = prior.epoch < epoch;
			if (acrossCompaction) counts.repeatsAcrossCompaction++;
			if (examples.length < MAX_EXAMPLES) examples.push({ tool, previous: prior.location, current: location, acrossCompaction });
		}
		seen.set(key, { epoch, location });
	}
	for (const entry of branch) {
		const line = locations.get(entry.id);
		if (entry.type === "compaction") { epoch++; counts.compactions++; }
		if (entry.type === "context_edit") counts.contextEdits++;
		if (entry.type !== "message") continue;
		counts.messages++;
		const message = entry.message;
		if (message.role === "user") counts.userMessages++;
		if (message.role === "assistant") {
			counts.assistantMessages++;
			if (message.stopReason === "error") counts.assistantErrors++;
			if (message.stopReason === "aborted") counts.assistantAborts++;
			for (const [block, item] of message.content.entries()) {
				if (item.type !== "toolCall") continue;
				if (typeof item.id !== "string" || typeof item.name !== "string" ||
					!item.arguments || typeof item.arguments !== "object" || Array.isArray(item.arguments) || pending.has(item.id)) {
					throw new Error(`Invalid or ambiguous tool call at line ${line}`);
				}
				pending.add(item.id);
				call(item.name, item.arguments, { line, block }, false);
			}
		}
		if (message.role === "toolResult") {
			if (typeof message.isError !== "boolean") throw new Error(`Missing tool error flag at line ${line}`);
			counts[message.isError ? "toolErrorResults" : "toolNonErrorResults"]++;
			if (!pending.delete(message.toolCallId)) counts.unmatchedToolResults++;
			if (message.nestedCalls) {
				if (!message.nestedCalls.complete) counts.incompleteNestedRecords++;
				for (const [nested, item] of message.nestedCalls.calls.entries()) {
					call(item.name, item.arguments, { line, nested }, true);
				}
			}
		}
	}
	counts.callsWithoutResult = pending.size;
	return {
		selection: "last-persisted-entry ancestry; original execution records, not reconstructed model context",
		counts, byTool, repeatedCallCandidates: examples,
		omittedCandidateExamples: counts.repeatedCalls - examples.length,
		assessment: { taskSuccess: "unknown", verificationOmissions: "not-assessed", unnecessaryRetries: "not-assessed", summaryConsistency: "not-assessed" },
	};
}

export async function analyzeFiles(paths) {
	if (!paths.length || paths.length > MAX_FILES) throw new Error(`Provide 1–${MAX_FILES} explicit session files`);
	const sessions = [];
	const seen = new Set();
	let totalBytes = 0;
	for (const [index, path] of paths.entries()) {
		try {
			const canonicalPath = await realpath(path);
			if (seen.has(canonicalPath)) throw new Error("Duplicate input");
			seen.add(canonicalPath);
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let bytes;
			try {
				const before = await file.stat();
				if (!before.isFile() || before.size > MAX_FILE_BYTES || totalBytes + before.size > MAX_TOTAL_BYTES) {
					throw new Error("Input exceeds snapshot limits");
				}
				// Bounded read even if a live writer appends. Stable snapshots are the supported input.
				const buffer = Buffer.alloc(before.size + 1);
				let length = 0;
				while (length < buffer.length) {
					const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
					if (!bytesRead) break;
					length += bytesRead;
				}
				const after = await file.stat();
				if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
					throw new Error("Input changed while reading");
				}
				bytes = buffer.subarray(0, length);
			} finally { await file.close(); }
			totalBytes += bytes.length;
			sessions.push({ input: index + 1, ...analyzeSession(bytes.toString("utf8")) });
		} catch {
			// Native JSON/fs errors can contain transcript text or private filenames.
			throw new Error(`Input ${index + 1} rejected: require a unique, stable, regular Pi v3 JSONL snapshot with a valid tree (16 MiB/file, 64 MiB/total)`);
		}
	}
	const totals = {};
	for (const session of sessions) for (const [name, value] of Object.entries(session.counts)) totals[name] = (totals[name] ?? 0) + value;
	return { schema: "rotom-trajectory-analysis/v1", totalBytes, totals, sessions,
		limitations: ["No model calls or outcome grading", "Repeated calls are candidates, not proven waste", "No source paths, IDs, arguments or message bodies in report", "Line numbers are 1-based; block/nested indices are 0-based", "Context edits counted but not applied to original execution history; unrecorded nested calls remain unknown"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log("Usage: node scripts/analyze-session-trajectories.mjs <snapshot.jsonl> [...]\nOffline, explicit files only. JSON report on stdout; no models or directory discovery.");
	} else {
		try { console.log(JSON.stringify(await analyzeFiles(process.argv.slice(2)), null, 2)); }
		catch (error) { console.error(error.message); process.exitCode = 1; }
	}
}
