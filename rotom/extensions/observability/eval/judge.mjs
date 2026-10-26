import { constants } from "node:fs";
import { access, chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { executeProcessTreeV1 } from "../../../runtime/process-tree.ts";
import { buildJudgeInput, JUDGE_MAX_INPUT_CHARS, JUDGE_PROMPT_VERSION, validateJudgment } from "./judge-prompt.mjs";
import { writeJudgment } from "./judge-store.mjs";
import { evalError, preview } from "./service.mjs";

export const JUDGE_TIMEOUT_MS = 180_000;
// Qoder reasoning routes stream token deltas, so a healthy run can exceed the
// former 512 KiB stdout cap. Keep a bounded but realistic ceiling.
export const JUDGE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const JUDGE_LAUNCHER = fileURLToPath(new URL("../../../bin/rotom-launcher", import.meta.url));
export const JUDGE_BASE_ARGS = ["--single-request", "-p", "--mode", "json", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-extensions", "--no-themes", "--no-mcp", "--no-approve"];

export function childEnvironment() {
	// Authentication is resolved by rotom in the child. Never read auth files or
	// copy API-key/token variables into a new credential-bearing interface.
	const names = ["HOME", "PATH", "TMPDIR", "TEMP", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PI_CODING_AGENT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ROTOM_QODER", "ROTOM_QODER_AUTH"];
	return { ...Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])), ROTOM_NODE: process.execPath };
}
export function parseModelCatalog(output) {
	if (!output.terminal.confirmed) throw evalError(503, "termination_unknown");
	if (output.terminal.outcome === "timeout") throw evalError(503, "models_timeout");
	if (output.terminal.outcome === "spawn-error") throw evalError(503, "launcher_unavailable");
	if (output.terminal.outcome !== "exited" || output.code !== 0) {
		throw evalError(503, /^rotom: \[runtime_validation_failed\]/mu.test(output.stderr) ? "models_identity_failed" : "models_exit_failed");
	}
	if (!output.stdout.trim()) throw evalError(503, "models_stdout_empty");
	let data; try { data = JSON.parse(output.stdout); } catch { throw evalError(503, "models_invalid_json"); }
	if (!data || !Array.isArray(data.models) || data.models.some((item) => !item || typeof item.id !== "string" || item.id.length > 512 || !item.id.includes("/") || /[\u0000-\u001f\u007f]/u.test(item.id))) throw evalError(503, "models_invalid_catalog");
	if (new Set(data.models.map((item) => item.id)).size !== data.models.length) throw evalError(503, "models_duplicate_ids");
	if (!(data.defaultModel === null || data.models.some((item) => item.id === data.defaultModel))) throw evalError(503, "models_default_missing");
	return { models: data.models.map(({ id }) => ({ id })), defaultModel: data.defaultModel };
}
function usageOf(message) {
	const usage = message?.usage;
	const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
	return { input: number(usage?.input), output: number(usage?.output), cacheRead: number(usage?.cacheRead), cacheWrite: number(usage?.cacheWrite),
		// Pi catalog-derived USD is an estimate, not a billing receipt. A zero
		// placeholder (notably Qoder) cannot prove a free request.
		costUsd: number(usage?.cost?.total) > 0 ? usage.cost.total : null, costSource: number(usage?.cost?.total) > 0 ? "pi_estimate" : "unknown", billing: "unknown" };
}
export function parseJudgeEvents(stdout, eventIds) {
	let message, ended = false, rawOutput = "", usage = usageOf(null);
	try {
		const rows = stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
		const messages = rows.filter((row) => row.type === "message_end" && row.message?.role === "assistant").map((row) => row.message);
		message = messages.at(-1);
		ended = rows.some((row) => row.type === "agent_end");
		rawOutput = (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
		usage = usageOf(message);
		if (!ended || messages.length !== 1) return { status: "failed", result: null, usage, failure: "incomplete_model_response" };
		if (message.stopReason !== "stop") {
			// Keep the provider's own bounded reason so the operator can act on it;
			// "error"/"aborted" are not truncation and must not be reported as such.
			const reason = message.stopReason === "length" || message.stopReason === "max_tokens" ? "output_truncated" : message.stopReason === "aborted" ? "cancelled" : "provider_error";
			const detail = preview(String(message.errorMessage ?? rawOutput ?? ""), 800);
			return { status: "failed", result: null, usage, failure: reason, ...(detail.text ? { rawOutput: detail.text } : {}) };
		}
		return { status: "ok", result: validateJudgment(JSON.parse(rawOutput), eventIds), usage };
	} catch {
		// A JSON body that stops mid-object is a truncation, not a format error.
		const body = (rawOutput || stdout).trim();
		return { status: "invalid_output", result: null, usage, rawOutput: preview(body, 8000).text, failure: body.endsWith("}") ? "invalid_output" : "output_truncated" };
	}
}

export function createJudgeService({ evalService, directory, launcher = JUDGE_LAUNCHER, timeoutMs = JUDGE_TIMEOUT_MS, maxOutputBytes = JUDGE_MAX_OUTPUT_BYTES, maxInputChars = JUDGE_MAX_INPUT_CHARS }) {
	let modelPromise, pending, run, unsafeTermination = false;
	const discoveryController = new AbortController();
	async function invoke(args, input, signal, deadline) {
		if (!isAbsolute(launcher)) throw evalError(503, "launcher_unavailable");
		let info;
		try { info = await lstat(launcher); await access(launcher, constants.X_OK); }
		catch { throw evalError(503, "launcher_unavailable"); }
		if (!info.isFile() || info.isSymbolicLink()) throw evalError(503, "launcher_unavailable");
		const executable = await realpath(launcher);
		const cwd = await mkdtemp(join(tmpdir(), "rotom-judge-"));
		await chmod(cwd, 0o700);
		let confirmed = false;
		try {
			const output = await executeProcessTreeV1(executable, args, { cwd, env: childEnvironment(), stdin: input, signal, timeoutMs: deadline, maxOutputBytes });
			confirmed = output.terminal.confirmed;
			if (!confirmed) unsafeTermination = true;
			return output;
		} finally {
			// Unknown process termination is not permission to remove its cwd or
			// launch another paid request. Leave it for operator reconciliation.
			if (confirmed) await rm(cwd, { recursive: true, force: true });
		}
	}
	async function models() {
		if (!modelPromise && unsafeTermination) throw evalError(409, "termination_unknown");
		if (!modelPromise) modelPromise = (async () => {
			const output = await invoke([...JUDGE_BASE_ARGS, "--list-models"], "", discoveryController.signal, 30_000);
			// Local diagnostic paths stay in process stderr, never the API,
			// trace records, or persisted judgments.
			if (output.stderr) console.error("[rotom-eval model discovery]\n" + output.stderr);
			return parseModelCatalog(output);
		})().catch((error) => { modelPromise = undefined; throw error; });
		return modelPromise;
	}
	function available() {
		if (unsafeTermination) throw evalError(409, "termination_unknown");
		if (run?.status === "running") throw evalError(409, "judge_busy");
	}
	async function finish(current, prepared) {
		const started = Date.now();
		let value;
		try {
			const output = await invoke([...JUDGE_BASE_ARGS, "--model", prepared.model], prepared.prompt, current.controller.signal, timeoutMs);
			// Local-only diagnostics: never forwarded to the API, trace records,
			// or judgments.
			if (output.stderr) console.error("[rotom-eval judge]\n" + preview(output.stderr, 2_000).text);
			const outcome = output.terminal.outcome;
			value = outcome === "exited" && output.code === 0 ? parseJudgeEvents(output.stdout, prepared.eventIds)
				: { status: outcome === "timeout" ? "timeout" : outcome === "aborted" ? "cancelled" : "failed", result: null, usage: usageOf(null), failure: outcome === "output-limit" ? "output_truncated" : outcome === "exited" ? "launcher_failed" : outcome };
		} catch { value = { status: "failed", result: null, usage: usageOf(null), failure: "launcher_unavailable" }; }
		const record = { sessionId: prepared.sessionId, atEntryId: prepared.atEntryId, model: prepared.model, promptVersion: JUDGE_PROMPT_VERSION,
			inputDigest: prepared.inputDigest, inputChars: prepared.inputChars, truncated: prepared.truncated, durationMs: Date.now() - started, ...value };
		try { await writeJudgment(directory, record); current.status = record.status; }
		catch { current.status = "failed"; current.error = "judgment_storage_unknown"; }
		current.processConfirmed = !unsafeTermination;
		// Do not retain the prompt or output after persistence.
	}
	return {
		models,
		async prepare(input) {
			available();
			if (!input || Object.keys(input).sort().join(",") !== "model,sessionId") throw evalError(400, "invalid_judge_input");
			const catalog = await models();
			if (!catalog.models.some((item) => item.id === input.model)) throw evalError(400, "invalid_model");
			const { loaded } = await evalService.snapshot(input.sessionId);
			available();
			const source = buildJudgeInput(loaded, maxInputChars);
			pending = { ...source, sessionId: input.sessionId, atEntryId: loaded.branch.at(-1)?.id ?? null, model: input.model, confirmationId: randomUUID(), createdAt: Date.now() };
			return { confirmationId: pending.confirmationId, model: pending.model, inputChars: source.inputChars, truncated: source.truncated, atEntryId: pending.atEntryId };
		},
		start(input) {
			available();
			if (!input || Object.keys(input).join(",") !== "confirmationId" || !pending || input.confirmationId !== pending.confirmationId || Date.now() - pending.createdAt > 300_000) throw evalError(409, "confirmation_expired");
			const prepared = pending; pending = null;
			run = { runId: randomUUID(), sessionId: prepared.sessionId, status: "running", controller: new AbortController() };
			run.done = finish(run, prepared);
			return { runId: run.runId, sessionId: run.sessionId, status: run.status };
		},
		status(runId) {
			if (!run || run.runId !== runId) throw evalError(404, "run_not_found");
			return { runId: run.runId, sessionId: run.sessionId, status: run.status, error: run.error, processConfirmed: run.processConfirmed };
		},
		activeFor(sessionId) { return run?.status === "running" && run.sessionId === sessionId ? { runId: run.runId, sessionId, status: "running" } : null; },
		cancel(input) {
			if (!input || Object.keys(input).join(",") !== "runId" || !run || run.runId !== input.runId || run.status !== "running") throw evalError(409, "run_not_running");
			run.controller.abort();
			return { runId: run.runId, status: "cancelling" };
		},
		async close() { pending = null; discoveryController.abort(); run?.controller.abort(); await Promise.allSettled([modelPromise, run?.done]); },
	};
}
