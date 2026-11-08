// Sensitive-action confirmation on the Pi side (T21).
//
// Three triggers are known without asking the relay — `upload`, accepting a
// `beforeunload` dialog, and (for future devtools work) `evaluate`. The relay reports the
// rest (`needs-confirmation`) after probing the target, so the wordlist lives in
// `chrome-extension/sensitive-actions.js` and is not duplicated here.
//
// Nothing here decides *whether* an action is sensitive on its own authority: the relay's
// probe is the source of truth for target names, and this module only decides how the
// refusal is described and whether the child-only local development escape hatch applies.
// Main agents approve sensitive actions automatically in index.ts (full access).

import { isLocalOriginV1 } from "./browser-policy.ts";

export const SENSITIVE_CONFIRM_ENV_V1 = "ROTOM_BROWSER_CONFIRM" as const;
/** Child agents only: the accepted local-development approval value. */
export const AUTO_APPROVE_LOCALHOST_V1 = "auto-approve-localhost" as const;

export type SensitiveReasonV1 = "payment-form" | "sensitive-name" | "upload" | "beforeunload" | "evaluate";

/**
 * `ROTOM_BROWSER_CONFIRM=auto-approve-localhost` lets e2e and local development
 * exercise sensitive child-agent actions without asking a user. It must do nothing
 * for a non-local origin. Main-agent full access does not depend on this switch.
 */
export function sensitiveAutoApprovedV1(input: { origin: string | undefined; env?: string | undefined }): boolean {
	if (input.env !== AUTO_APPROVE_LOCALHOST_V1) return false;
	if (input.origin === undefined) return false;
	return isLocalOriginV1(input.origin);
}

/** Triggers the Pi layer knows about before any target probe. */
export function preflightSensitiveReasonV1(input: { action: string; dialogType?: string | undefined }): SensitiveReasonV1 | undefined {
	if (input.action === "upload") return "upload";
	// A beforeunload dialog asks the user to leave unsaved work behind; both answers are
	// consequential, so both use the sensitive-action approval path.
	if (input.action === "dialog" && input.dialogType === "beforeunload") return "beforeunload";
	return undefined;
}

/** Bounded, whitelisted view of a relay `needs-confirmation` refusal. */
export function sanitizeSensitiveConfirmationV1(value: unknown): { reason: SensitiveReasonV1; matchedWord: string | undefined; origin: string } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.kind !== "needs-confirmation") return undefined;
	if (record.reason !== "payment-form" && record.reason !== "sensitive-name") return undefined;
	// The page's own label is deliberately not echoed back to the model.
	const matchedWord = typeof record.matchedWord === "string" && record.matchedWord.length > 0 && record.matchedWord.length <= 40 ? record.matchedWord : undefined;
	return { reason: record.reason, matchedWord, origin: typeof record.origin === "string" ? record.origin.slice(0, 512) : "" };
}

/** One-line description for the confirm dialog and for the refusal message. */
export function sensitiveReasonTextV1(input: { reason: SensitiveReasonV1; matchedWord?: string | undefined }): string {
	if (input.reason === "payment-form") return "该目标在含 cc-* 自动填充字段的支付表单里";
	if (input.reason === "sensitive-name") return `目标名称命中敏感词“${input.matchedWord ?? ""}”`;
	if (input.reason === "upload") return "该操作会把本地文件交给页面";
	if (input.reason === "beforeunload") return "该操作会离开有未保存内容的页面";
	return "该操作会在页面里执行脚本";
}
