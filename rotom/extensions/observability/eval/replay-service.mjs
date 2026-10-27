// Dashboard-side replay service: replay points and the replay runner process.
//
// The runner is a separate Node process on purpose. Generation loads a whole
// product runtime and models can take minutes, so the dashboard must be able to
// report progress, cancel, and stay responsive while a replay runs.
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalError } from "./service.mjs";
import {
	cutEntries, deleteReplayCase, readReplayCases, readReplayRuns, replayCaseKey, replayConclusion, REPLAY_SESSION_MAX_BYTES, sessionSha256, writeReplayCase,
} from "./replay.mjs";
import { clampRepeats, measureReplayPlan } from "./replay-plan.mjs";

const RUNNER = fileURLToPath(new URL("../../../evals/scripts/session-replay.mjs", import.meta.url));
const MAX_PROGRESS_LINES = 200;

/**
 * Resolves the comparison arm from an explicit setting. A baseline is only
 * enabled when the value is an absolute product directory that actually looks
 * like one; anything else stays off with the reason, so the panel can hide the
 * option instead of silently comparing the product with itself.
 */
export async function resolveReplayBaseline(value) {
	if (value === undefined || value === null || value === "") return { enabled: false, reason: "not_configured" };
	if (typeof value !== "string" || !isAbsolute(value)) return { enabled: false, reason: "not_absolute" };
	const info = await lstat(value).catch(() => undefined);
	// A symlink would make "the baseline product" depend on wherever it points.
	if (info?.isSymbolicLink()) return { enabled: false, reason: "symlink" };
	if (!info?.isDirectory()) return { enabled: false, reason: "not_a_directory" };
	const marker = await lstat(join(value, "runtime", "product-config.mjs")).catch(() => undefined);
	if (!marker?.isFile()) return { enabled: false, reason: "not_a_product" };
	return { enabled: true, path: value };
}

export function createReplayService({ directory, sessionsRoot, product, armBaseline, sessionFile = (id) => join(sessionsRoot, `${id}.jsonl`), spawnProcess = spawn, node = process.execPath, env = process.env }) {
	if (!sessionsRoot || !product) throw new Error("replay service needs a session root and a product directory");
	const runs = new Map();

	async function sessionDigest(sessionId) {
		// Reading only to hash: the case needs a digest, not a copy of the session.
		return sessionSha256(await readFile(await sessionFile(sessionId), "utf8"));
	}

	const baseline = armBaseline?.enabled === true ? armBaseline : { enabled: false, reason: armBaseline?.reason ?? "not_configured" };

	async function loadBranch(sessionId, cutEntryId) {
		const { loadSession } = await import("./session-data.mjs");
		const loaded = await loadSession(await sessionFile(sessionId), { badJson: 0, lineTooLong: 0 }, new Set(), REPLAY_SESSION_MAX_BYTES);
		if (loaded.reason || !loaded.branch) throw evalError(400, "cannot_read_session");
		const cut = cutEntries(loaded.branch, cutEntryId);
		if (!cut) throw evalError(400, "invalid_replay_point");
		return cut.entries;
	}

	return {
		async cases() {
			const [cases, runs] = await Promise.all([readReplayCases(directory), readReplayRuns(directory)]);
			return {
				cases: cases.map((item) => {
					const arms = runs.get(item.key) ?? {};
					return {
						...item,
						// The candidate row stays `latest` for the existing list, and every
						// arm is exposed so the panel can show the control side by side.
						latest: arms.candidate ?? null, arms,
						conclusion: replayConclusion({ original: arms.original, candidate: arms.candidate }),
					};
				}),
				baseline: { enabled: baseline.enabled, reason: baseline.enabled ? null : baseline.reason }, originalArm: true,
			};
		},
		/** Numbers for the confirmation dialog; never starts a run. */
		async prepare(input) {
			const ids = Array.isArray(input?.cases) ? input.cases.filter((id) => typeof id === "string" && id) : [];
			if (!ids.length) throw evalError(400, "invalid_replay_request");
			const includeBaseline = input?.includeBaseline === true;
			if (includeBaseline && !baseline.enabled) throw evalError(400, "baseline_unavailable");
			const all = await readReplayCases(directory);
			const items = [];
			for (const id of ids) {
				const item = all.find((row) => row.key === id || row.sessionId === id);
				if (!item) throw evalError(400, "invalid_replay_point");
				items.push({ key: item.key, check: item.check, expected: item.expected, entries: await loadBranch(item.sessionId, item.cutEntryId) });
			}
			const repeats = clampRepeats(input?.repeats);
			return { ...measureReplayPlan({ items, repeats, arms: includeBaseline ? 2 : 1 }), includeBaseline };
		},
		async add(input) {
			const digest = await sessionDigest(input?.sessionId);
			return writeReplayCase(directory, input, digest);
		},
		async remove(input) { return deleteReplayCase(directory, input?.sessionId, input?.cutEntryId); },
		async start(input) {
			const ids = Array.isArray(input?.cases) ? input.cases.filter((id) => typeof id === "string") : [];
			const repeats = Math.min(Math.max(Number(input?.repeats) || 1, 1), 3);
			if (!ids.length) throw evalError(400, "invalid_replay_request");
			if (typeof input?.model !== "string" || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/iu.test(input.model)) throw evalError(400, "invalid_replay_request");
			// The comparison arm comes only from the explicit setting; guessing a
			// baseline would compare the product with itself.
			if (input.includeBaseline === true && !baseline.enabled) throw evalError(400, "baseline_unavailable");
			const args = [RUNNER, `--product=${product}`, "--arm=candidate", `--model=${input.model}`, `--repeats=${repeats}`, `--cases=${ids.join(",")}`, `--directory=${directory}`, `--sessions=${sessionsRoot}`];
			if (input.includeBaseline === true) args.push(`--arm-baseline=${baseline.path}`);
			// Real sessions live in nested project folders, so the runner gets the
			// resolved file per session instead of guessing a path. `ids` are case
			// keys, so each one still has to be mapped back to its session.
			const known = await readReplayCases(directory);
			const paths = {};
			for (const id of ids) {
				const item = known.find((row) => row.key === id || row.sessionId === id);
				if (!item) throw evalError(400, "invalid_replay_point");
				paths[item.sessionId] = await sessionFile(item.sessionId);
			}
			args.push(`--paths=${JSON.stringify(paths)}`);
			const child = spawnProcess(node, args, { env: { ...env, ROTOM_REPLAY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
			const armCount = input.includeBaseline === true ? 2 : 1;
			// Count the original control: it runs once per point, not per repetition.
			const state = { runId: `replay-${Date.now().toString(36)}`, cases: ids.length, repeats, arms: armCount, done: 0, total: ids.length * (repeats * armCount + 1), status: "running", results: [], conclusions: [], warnings: [], error: null };
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
						if (Array.isArray(row.conclusions)) state.conclusions = row.conclusions;
						if (Array.isArray(row.warnings)) state.warnings = row.warnings;
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
			return { runId: state.runId, status: state.status, done: state.done, total: state.total, cases: state.cases, repeats: state.repeats, arms: state.arms, results: state.results, conclusions: state.conclusions, warnings: state.warnings, error: state.error };
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
