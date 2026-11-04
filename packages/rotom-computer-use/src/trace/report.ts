/**
 * Local trace export: turn one agent's JSONL into a Markdown report with a
 * screenshot timeline. Pure function over files, so it is testable without a
 * helper, and it never leaves the machine by itself.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TraceEntry } from "./recorder.ts";

export function exportTraceMarkdown(sessionDir: string, agentFileName: string): string {
	const entries = readEntries(path.join(sessionDir, agentFileName));
	const shots = entries.flatMap((entry) => entry.screenshots ?? []);
	const lines: string[] = [
		`# Computer Use trace: ${agentFileName.replace(/\.jsonl$/, "")}`,
		"",
		`Session directory: \`${sessionDir}\``,
		`Entries: ${entries.length} · Screenshots: ${shots.length}`,
		"",
		"| Time | Tool | Action | Delivery | Status | Evidence |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const entry of entries) {
		lines.push(
			`| ${timeOf(entry)} | ${cell(entry.tool)} | ${cell(describeTarget(entry))} | ${cell(entry.deliveryLevel ?? "-")} | ${cell(entry.status)} | ${cell(evidenceOf(entry))} |`,
		);
	}
	const shotLines = entries.flatMap((entry) => (entry.screenshots ?? []).map((shot) => `- ${timeOf(entry)} — \`${shot}\` (${entry.tool})`));
	if (shotLines.length) lines.push("", "## Screenshot timeline", "", ...shotLines);
	lines.push("", "Text inputs are recorded as length and SHA-256 only; typed content is never stored.", "");
	return lines.join("\n");
}

function readEntries(file: string): TraceEntry[] {
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.flatMap((line) => {
			if (!line.trim()) return [];
			try {
				return [JSON.parse(line) as TraceEntry];
			} catch {
				return [];
			}
		});
}

function timeOf(entry: TraceEntry): string {
	const stamped = entry as TraceEntry & { ts?: string };
	return typeof stamped.ts === "string" ? stamped.ts : "-";
}

function describeTarget(entry: TraceEntry): string {
	const target = entry.target;
	if (!target) return "-";
	const parts = [target.role, target.label, target.ref].filter(Boolean) as string[];
	return parts.length ? parts.join(" ") : "-";
}

function evidenceOf(entry: TraceEntry): string {
	const parts: string[] = [];
	if (entry.evidence) parts.push(entry.evidence);
	if (entry.text) parts.push(`text(${entry.text.length} chars, sha256 ${entry.text.sha256.slice(0, 12)}…)`);
	if (entry.lease?.agentId) parts.push(`lease ${entry.lease.agentId}${entry.lease.epoch !== undefined ? ` @${entry.lease.epoch}` : ""}`);
	return parts.length ? parts.join("; ") : "-";
}

/** Markdown tables break on raw pipes and newlines. */
function cell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim() || "-";
}
