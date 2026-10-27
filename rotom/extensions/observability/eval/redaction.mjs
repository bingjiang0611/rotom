// Best-effort credential redaction for judge input.
//
// The dashboard sends a bounded summary of local session text to a model chosen
// by the operator. Session text can contain credentials that were pasted or
// printed during the original work, so every text field is redacted before it
// is truncated or serialised into the prompt.
//
// This is deliberately a denylist. It cannot prove a prompt is secret-free:
// unknown formats, split tokens and secrets never printed in a recognised shape
// still pass through. The value is that the common shapes stop leaving the
// machine, and that the operator sees how many replacements were made.

/**
 * Named patterns so a future format is one entry, not an edit spread across code.
 *
 * Every quantifier is bounded. An unbounded `+` over a multi-megabyte run — a
 * base64 blob pasted into a session, for example — overflows the regex engine's
 * stack and throws `RangeError` instead of redacting, which took the whole judge
 * and replay request down. The bounds sit far above any real credential, so a
 * long run is simply not a credential; a real key inside a large field still is.
 */
export const CREDENTIAL_PATTERNS = [
	{ type: "private-key", pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/gu },
	{ type: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{16,4096}/gu },
	// `sk-`, optionally a few dash-separated prefix segments (`proj-`), then one
	// contiguous 20+ alphanumeric run. Compatible-OpenAI services (DeepSeek and
	// others) issue `sk-` plus lowercase hex, so case cannot be the signal. A
	// package name such as `sk-learn-…-pipeline-v2` never has a run that long:
	// every dash-separated segment is short.
	{ type: "openai-key", pattern: /\bsk-(?!ant-)(?:[A-Za-z0-9]{1,12}-){0,16}[A-Za-z0-9]{20,4096}/gu },
	{ type: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,4096}|\bgithub_pat_[A-Za-z0-9_]{20,4096}/gu },
	{ type: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
	{ type: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,4096}/gu },
	{ type: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/gu },
	{ type: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,4096}/gu },
	// Keyword assignment. The keyword may sit inside a longer identifier so
	// environment variables and headers are covered: `OPENAI_API_KEY`,
	// `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `x-api-key`. `pwd` is deliberately
	// absent: printing the working directory is normal work, not a secret.
	// Group 1 is the full identifier, group 2 the candidate value.
	// A closing quote may sit between the key and the colon, so JSON object keys
	// (`{"apiKey": "…"}`) are covered too.
	{ type: "assigned-secret", pattern: /(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_-]){0,16}(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd)(?:[_-][A-Za-z0-9]+){0,16})["']?\s*[:=]\s*["']?([^\s"',;]{8,4096})["']?/giu },
];

/**
 * Values that look like a secret reference, not a secret. Redacting them would
 * corrupt the code and paths a judge needs to read (`PWD=/Users/...`,
 * `secret = os.environ['X']`, `password: ********`, `token=2048tokens`).
 * A bare number is *not* a reference: numeric passwords and PINs are common, so
 * only "digits plus a unit" (`2048tokens`) is skipped.
 */
export function looksLikeReference(value) {
	const candidate = String(value ?? "").replace(/^["']|["']$/gu, "");
	return candidate.startsWith("/") || candidate.startsWith("$") || candidate.startsWith("<") || candidate.startsWith("*") ||
		candidate.startsWith(".") || /^(?:os\.environ|process\.env|os\.getenv|env\[|env\.|import\.meta\.env)/u.test(candidate) ||
		/^\d+[a-z]+$/iu.test(candidate) || /^[*x.]+$/iu.test(candidate);
}

/**
 * Identifiers that only look like credentials: token *budgets* are ordinary
 * configuration, and redacting `MAX_TOKENS=200000` would hide the very numbers a
 * judge needs to read.
 */
// The prefix is mandatory: a bare `token` is a credential, only `tokens`
// (the plural budget name) and `max_tokens`-style identifiers are configuration.
const NOT_SECRET_IDENTIFIER = /^(?:(?:max|min|top|num|total|budget)[_-]?tokens?|tokens)$/iu;

/** Only `assigned-secret` captures an identifier and a value; the others have no groups. */
const ASSIGNED_SECRET = "assigned-secret";

/** Replacement keeps the type visible so the operator can see what was caught. */
export function redactionMarker(type) { return `[已脱敏:${type}]`; }

/**
 * Redacts one string.
 * @returns redacted text plus per-type counts; `counts` is empty for clean text.
 */
export function redactSecrets(value) {
	let text = typeof value === "string" ? value : "";
	const counts = new Map();
	for (const { type, pattern } of CREDENTIAL_PATTERNS) {
		// Rebuild the RegExp so the shared literal never keeps `lastIndex` state.
		const matcher = new RegExp(pattern.source, pattern.flags);
		// Extra arguments are `(match, …groups, offset, wholeString)`. Reading a
		// group on a pattern without groups would hand us the offset and the whole
		// string, so only the rule that declares groups may look at them.
		text = text.replace(matcher, (match, ...rest) => {
			if (type === ASSIGNED_SECRET) {
				const [identifier, value] = rest;
				// A value already replaced by an earlier pattern is not a new secret;
				// re-matching it would report two hits for one credential.
				if (value.includes("[已脱敏:")) return match;
				if (NOT_SECRET_IDENTIFIER.test(identifier) || looksLikeReference(value)) return match;
			}
			counts.set(type, (counts.get(type) ?? 0) + 1);
			return redactionMarker(type);
		});
	}
	return { text, redactions: [...counts].map(([type, count]) => ({ type, count })) };
}

export function redactionList(counts) {
	return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => ({ type, count }));
}

export function redactionTotal(redactions) {
	return (redactions ?? []).reduce((sum, entry) => sum + entry.count, 0);
}
