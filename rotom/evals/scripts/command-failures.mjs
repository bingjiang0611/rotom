import { createHash } from "node:crypto";
import { canonicalJson } from "./trace-assertions.mjs";

export const RETRY_FAILURE_THRESHOLD = 3;
export const FAILURE_STREAK_THRESHOLD = 5;
export const COMMAND_PROGRAMS = Object.freeze({
	search: ["grep", "rg", "find", "fd", "ls"],
	test: ["vitest", "jest", "pytest"],
	build: ["tsc", "make"],
	lint: ["eslint", "prettier", "ruff"],
	git: ["git"],
	read: ["cat", "head", "tail", "wc"],
	run: ["node", "python", "python3", "bash", "sh", "zsh", "ruby", "perl"],
});
export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn"];
export const PACKAGE_ACTIONS = ["install", "ci", "add"];
const PREFIX_FLAGS = { sudo: ["--", "-n", "-E", "-H"], env: ["--"], npx: ["--", "-y", "--yes", "--no-install"] };
export const SCRIPT_RULES = [
	["test", /^test/u], ["build", /^build|^typecheck$/u], ["lint", /^lint/u],
];
export const COMMAND_CATEGORIES = ["search", "test", "build", "lint", "git", "package", "read", "run", "other"];

// A deliberately small shell lexer, not an executor. Quoting/escaping and
// separators suffice for the prefixes below. Substitutions, redirection in
// program position and unsupported wrappers remain other; never eval a command.
function tokensOf(text) {
	const tokens = [];
	let word = "", quote = "", started = false;
	const flush = () => { if (started) tokens.push(word); word = ""; started = false; };
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\\" && quote !== "'") {
			if (i + 1 === text.length) return [];
			const next = text[++i];
			if (next !== "\n") { word += next; started = true; }
		} else if (quote) {
			if (char === quote) quote = "";
			else word += char;
		} else if (char === "'" || char === '"') { quote = char; started = true; }
		else if ("&|;\n".includes(char)) {
			flush();
			if ((char === "&" || char === "|") && text[i + 1] === char) tokens.push(char + text[++i]);
			else tokens.push(char);
		} else if (/\s/u.test(char)) flush();
		else { word += char; started = true; }
	}
	if (quote) return [];
	flush();
	return tokens;
}

export function commandCategory(commandText) {
	if (typeof commandText !== "string" || /\$\(|`/u.test(commandText)) return "other";
	let tokens = tokensOf(commandText.trim());
	while (tokens.length) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0])) { tokens.shift(); continue; }
		if (/[${}()<>]/u.test(tokens[0])) return "other";
		const program = tokens[0].split("/").at(-1);
		if (program === "cd") {
			const separator = tokens.findIndex((token) => ["&&", "||", ";", "|", "&", "\n"].includes(token));
			if (separator < 0 || tokens[separator] !== "&&") return "other";
			tokens = tokens.slice(separator + 1); continue;
		}
		if (program === "sudo" || program === "env" || program === "npx") {
			tokens.shift();
			// Only options with known arity; unfamiliar switches are not guessed.
			while (tokens.length) {
				if (PREFIX_FLAGS[program].includes(tokens[0])) { tokens.shift(); continue; }
				if (program === "sudo" && ["-u", "-g"].includes(tokens[0]) && tokens.length > 1) { tokens.splice(0, 2); continue; }
				break;
			}
			continue;
		}
		if ((program === "pnpm" || program === "npm") && tokens[1] === "exec") { tokens.splice(0, tokens[2] === "--" ? 3 : 2); continue; }
		break;
	}
	const end = tokens.findIndex((token) => ["&&", "||", ";", "|", "&", "\n"].includes(token));
	if (end >= 0) tokens = tokens.slice(0, end);
	const [rawProgram = "", ...args] = tokens;
	if (/[${}()<>]/u.test(rawProgram)) return "other";
	const program = rawProgram.split("/").at(-1);
	if (PACKAGE_MANAGERS.includes(program)) {
		if (PACKAGE_ACTIONS.includes(args[0])) return "package";
		if (program === "npm" && args[0] !== "run") return args[0] === "test" ? "test" : "other";
		const script = args[0] === "run" ? args[1] : args[0];
		for (const [category, pattern] of SCRIPT_RULES) if (typeof script === "string" && pattern.test(script)) return category;
		return "other";
	}
	if (["go", "cargo"].includes(program)) return args[0] === "test" ? "test" : args[0] === "build" ? "build" : "other";
	// node options precede the script/test path; --test after a script is its argument.
	const firstOperand = args.findIndex((arg) => !arg.startsWith("-"));
	if (program === "node" && args.slice(0, firstOperand < 0 ? args.length : firstOperand).includes("--test")) return "test";
	if (program === "sed") return args[0] === "-n" ? "read" : "other";
	for (const [category, programs] of Object.entries(COMMAND_PROGRAMS)) if (programs.includes(program)) return category;
	return "other";
}

/** Exact command strings stay exact. Only object key order is normalized. */
export function callFingerprint(toolName, args) {
	return createHash("sha256").update(canonicalJson([toolName, args])).digest("hex");
}

export function failureLoops(calls) {
	const previous = new Map();
	let retries = 0, longest = 0, streak = 0, failures = 0, unknown = 0;
	for (const { fingerprint, failed } of calls) {
		if (failed === true) {
			failures++;
			if (previous.get(fingerprint) === true) retries++;
			longest = Math.max(longest, ++streak);
		} else { streak = 0; if (failed === null) unknown++; }
		previous.set(fingerprint, failed);
	}
	return { calls: calls.length, failures, unknown, retries, longest, looping: retries >= RETRY_FAILURE_THRESHOLD || longest >= FAILURE_STREAK_THRESHOLD };
}

const emptyCount = () => ({ calls: 0, failures: 0, unknown: 0, searchExit1: 0 });
const emptyCategories = () => Object.fromEntries(COMMAND_CATEGORIES.map((category) => [category, { bash: emptyCount(), then_run: emptyCount() }]));

/** Per-session reduction. Text, arguments and fingerprints never leave this function. */
export function sessionCommandFailures(branch, traceTools) {
	const results = new Map();
	const calls = [];
	for (const entry of branch) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "toolResult") results.set(message.toolCallId, message);
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) if (part?.type === "toolCall") calls.push(part);
		}
	}
	const sources = { trace: 0, toolResult: 0, unknown: 0 };
	const categories = emptyCategories();
	const loopCalls = [];
	for (const call of calls) {
		const result = results.get(call.id);
		const attributes = typeof call.id === "string" ? traceTools.get(createHash("sha256").update(call.id).digest("hex")) : undefined;
		const outcome = attributes?.["pi.tool.outcome"];
		const source = typeof outcome === "string" ? "trace" : typeof result?.isError === "boolean" ? "toolResult" : "unknown";
		const failed = source === "trace" ? outcome !== "ok" : source === "toolResult" ? result.isError : null;
		sources[source]++;
		loopCalls.push({ fingerprint: callFingerprint(call.name, call.arguments), failed });
		const args = call.arguments;
		const channel = call.name === "bash" ? "bash" : call.name === "edit" && args?.then_run ? "then_run" : null;
		if (!channel) continue;
		const command = channel === "bash" ? args?.command : args.then_run.command;
		const category = commandCategory(command);
		const count = categories[category][channel];
		count.calls++;
		let commandFailed = failed;
		if (channel === "then_run") {
			const fusion = result?.details?.actionFusion;
			const phases = result?.details?.codingPhases;
			const localPhase = phases?.mutation === "applied" ? phases.followup
				: fusion?.version === 1 && fusion.mutation === "applied" ? fusion.followup : undefined;
			const followup = attributes?.["pi.tool.followup_status"] ?? localPhase;
			// A rejected edit never ran its command. Missing phase evidence cannot
			// turn a failed mutation into a failed command, even when isError=true.
			commandFailed = followup === "failed" ? true : followup === "succeeded" ? false : null;
		}
		if (commandFailed === true) count.failures++;
		if (commandFailed === null) count.unknown++;
		const exitCode = attributes?.["pi.tool.exit_code"] ?? result?.details?.exitCode;
		if (category === "search" && commandFailed === true && exitCode === 1) count.searchExit1++;
	}
	return { categories, sources, loops: failureLoops(loopCalls) };
}

export function aggregateCommandFailures(rows) {
	const categories = emptyCategories();
	const sources = { trace: 0, toolResult: 0, unknown: 0 };
	const labels = { looping: { pass: 0, fail: 0 }, nonLooping: { pass: 0, fail: 0 }, n: 0 };
	let failures = 0, loopingFailures = 0, loopingSessions = 0, retries = 0, longStreakSessions = 0, loopingCommandFailures = 0;
	for (const row of rows) {
		for (const category of COMMAND_CATEGORIES) for (const channel of ["bash", "then_run"]) {
			const count = row.categories[category][channel];
			for (const key of Object.keys(count)) categories[category][channel][key] += count[key];
			if (row.loops.looping) loopingCommandFailures += count.failures;
		}
		for (const key of Object.keys(sources)) sources[key] += row.sources[key];
		failures += row.loops.failures;
		retries += row.loops.retries;
		if (row.loops.longest >= FAILURE_STREAK_THRESHOLD) longStreakSessions++;
		if (row.loops.looping) { loopingSessions++; loopingFailures += row.loops.failures; }
		if (row.verdict === "pass" || row.verdict === "fail") {
			labels[row.loops.looping ? "looping" : "nonLooping"][row.verdict]++; labels.n++;
		}
	}
	const commandFailures = Object.values(categories).reduce((sum, row) => sum + row.bash.failures + row.then_run.failures, 0);
	for (const row of Object.values(categories)) for (const count of Object.values(row)) {
		const known = count.calls - count.unknown;
		count.rate = known ? count.failures / known : null;
		count.share = commandFailures ? count.failures / commandFailures : null;
	}
	const longest = rows.map((row) => row.loops.longest).sort((a, b) => a - b);
	const n = longest.length;
	return {
		categories, sources, commandFailures, labels,
		loops: {
			sessions: n, retries, loopingSessions, longStreakSessions, failures, loopingFailures,
			failureShare: failures ? loopingFailures / failures : null,
			loopingCommandFailures, commandFailureShare: commandFailures ? loopingCommandFailures / commandFailures : null,
			longest: { n, median: n ? (longest[Math.floor((n - 1) / 2)] + longest[Math.floor(n / 2)]) / 2 : null, p90: n ? longest[Math.ceil(n * 0.9) - 1] : null },
		},
	};
}
