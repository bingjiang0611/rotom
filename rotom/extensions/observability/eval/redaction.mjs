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

/** Named patterns so a future format is one entry, not an edit spread across code. */
export const CREDENTIAL_PATTERNS = [
	{ type: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu },
	{ type: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/gu },
	// OpenAI keys always carry upper-case or digit groups; all-lowercase
	// `sk-…` strings are normally package names (`sk-learn-preprocessing-…`).
	{ type: "openai-key", pattern: /\bsk-(?!ant-)(?=[A-Za-z0-9_-]{16,})(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{16,}/gu },
	{ type: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/gu },
	{ type: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
	{ type: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu },
	{ type: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu },
	{ type: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gu },
	// Keyword assignment. `pwd` is deliberately absent: printing the working
	// directory is normal work, not a secret. Values that are paths, shell
	// expansions, placeholders or environment lookups are left alone.
	{ type: "assigned-secret", pattern: /\b(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?([^\s"',;]{8,})["']?/giu },
];

/**
 * Values that look like a secret reference, not a secret. Redacting them would
 * corrupt the code and paths a judge needs to read (`PWD=/Users/...`,
 * `secret = os.environ['X']`, `password: ********`, `token=2048tokens`).
 */
export function looksLikeReference(value) {
	const candidate = String(value ?? "").replace(/^["']|["']$/gu, "");
	return candidate.startsWith("/") || candidate.startsWith("$") || candidate.startsWith("<") || candidate.startsWith("*") ||
		candidate.startsWith(".") || /^(?:os\.environ|process\.env|os\.getenv|env\[|env\.|import\.meta\.env)/u.test(candidate) ||
		/^\d+[a-z]*$/iu.test(candidate) || /^[*x.]+$/iu.test(candidate);
}

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
		text = text.replace(matcher, (match, value) => {
			if (type === "assigned-secret" && looksLikeReference(value)) return match;
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
