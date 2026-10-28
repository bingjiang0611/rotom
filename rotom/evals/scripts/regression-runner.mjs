// The process boundary of a regression run: the plan digest a person confirms and the
// child process that executes it.
//
// Kept apart from the CLI so the confirmation contract and the spawn are reviewable on
// their own, and so the CLI stays about decisions rather than pipes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const RUNNER = fileURLToPath(new URL("./session-replay.mjs", import.meta.url));

/** Everything a person confirms, including the content identity of both products. */
export function planDigestOf({ set, model, repeats, extensions, extensionIdentities, thinkingLevel, arms }) {
	return createHash("sha256").update(JSON.stringify({
		set: set.digest, model, repeats, extensions, thinkingLevel: thinkingLevel ?? null,
		baseline: arms.baseline.digest, candidate: arms.candidate.digest,
		extensionIdentities: extensionIdentities.map((item) => item.digest), cases: set.cases.map((item) => item.key),
	})).digest("hex");
}

/** One runner process; JSON lines carry progress, the last object carries results. */
export function runReplayRunner({ node, args, env, onLine }) {
	return new Promise((resolve) => {
		const child = spawn(node, [RUNNER, ...args], { env: { ...env, ROTOM_REPLAY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let buffered = "", stderr = "", result;
		const lines = [];
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			const parts = buffered.split("\n");
			buffered = parts.pop() ?? "";
			for (const line of parts) {
				if (!line.trim()) continue;
				let row;
				try { row = JSON.parse(line); } catch { onLine?.({ text: line }); continue; }
				lines.push(row);
				if (row.progress) onLine?.(row);
				else if (Array.isArray(row.runs)) result = row;
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
		child.once("error", (error) => resolve({ code: 1, result: undefined, stderr: String(error?.message ?? error), lines }));
		child.once("close", (code) => resolve({ code: code ?? 1, result, stderr: stderr.trim(), lines }));
	});
}
