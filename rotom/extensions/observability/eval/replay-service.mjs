// Dashboard-side replay service: replay points and the replay runner process.
//
// The runner is a separate Node process on purpose. Generation loads a whole
// product runtime and models can take minutes, so the dashboard must be able to
// report progress, cancel, and stay responsive while a replay runs.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	deleteReplayCase, readReplayCases, readReplayRuns, replayCaseKey, sessionSha256, writeReplayCase,
} from "./replay.mjs";

const RUNNER = fileURLToPath(new URL("../../../evals/scripts/session-replay.mjs", import.meta.url));
const MAX_PROGRESS_LINES = 200;

export function createReplayService({ directory, sessionsRoot, product, armBaseline, spawnProcess = spawn, node = process.execPath, env = process.env }) {
	if (!sessionsRoot || !product) throw new Error("replay service needs a session root and a product directory");
	const runs = new Map();

	async function sessionDigest(sessionId) {
		const path = join(sessionsRoot, `${sessionId}.jsonl`);
		// Reading only to hash: the case needs a digest, not a copy of the session.
		return sessionSha256(await readFile(path, "utf8"));
	}

	return {
		async cases() {
			const [cases, runs] = await Promise.all([readReplayCases(directory), readReplayRuns(directory)]);
			return { cases: cases.map((item) => ({ ...item, latest: runs.get(item.key) ?? null })) };
		},
		async add(input) {
			const digest = await sessionDigest(input?.sessionId);
			return writeReplayCase(directory, input, digest);
		},
		async remove(input) { return deleteReplayCase(directory, input?.sessionId, input?.cutEntryId); },
		start(input) {
			const ids = Array.isArray(input?.cases) ? input.cases.filter((id) => typeof id === "string") : [];
			const repeats = Math.min(Math.max(Number(input?.repeats) || 1, 1), 3);
			if (!ids.length) throw new Error("invalid_replay_request");
			if (typeof input?.model !== "string" || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/iu.test(input.model)) throw new Error("invalid_replay_request");
			const args = [RUNNER, `--product=${product}`, "--arm=candidate", `--model=${input.model}`, `--repeats=${repeats}`, `--cases=${ids.join(",")}`, `--directory=${directory}`, `--sessions=${sessionsRoot}`];
			if (input.includeBaseline === true) args.push(`--arm-baseline=${armBaseline ?? product}`);
			const child = spawnProcess(node, args, { env: { ...env, ROTOM_REPLAY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
			const state = { runId: `replay-${Date.now().toString(36)}`, cases: ids.length, repeats, arms: input.includeBaseline === true ? 2 : 1, done: 0, total: ids.length * repeats * (input.includeBaseline === true ? 2 : 1), status: "running", results: [], error: null };
			const record = { child, state };
			let buffered = "";
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk) => {
				buffered += chunk;
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines.slice(-MAX_PROGRESS_LINES)) {
					try {
						const row = JSON.parse(line);
						if (row.progress) state.done = Math.min(row.progress.done ?? state.done, state.total);
						else if (Array.isArray(row.runs)) state.results = row.runs;
					} catch { /* the runner also writes human text; ignore non-JSON lines */ }
				}
			});
			child.stderr?.setEncoding("utf8");
			let stderr = "";
			child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
			child.once("close", (code) => {
				state.status = state.status === "cancelled" ? "cancelled" : code === 0 ? "done" : "failed";
				if (state.status === "failed") state.error = stderr.trim().slice(0, 800) || `runner exited ${code}`;
				state.done = state.status === "done" ? state.total : state.done;
			});
			runs.set(state.runId, record);
			return { runId: state.runId, total: state.total, arms: state.arms };
		},
		status(runId) {
			const record = runs.get(runId);
			if (!record) return { status: "unknown", runId: runId ?? null };
			const { state } = record;
			return { runId: state.runId, status: state.status, done: state.done, total: state.total, cases: state.cases, repeats: state.repeats, arms: state.arms, results: state.results, error: state.error };
		},
		cancel(runId) {
			const record = runs.get(runId);
			if (!record || record.state.status !== "running") return { cancelled: false, status: record?.state.status ?? "unknown" };
			record.state.status = "cancelled";
			record.child.kill("SIGTERM");
			return { cancelled: true, status: "cancelled" };
		},
		close() {
			for (const { child, state } of runs.values()) {
				if (state.status === "running") { state.status = "cancelled"; child.kill("SIGTERM"); }
				runs.delete(state.runId);
			}
		},
	};
}
