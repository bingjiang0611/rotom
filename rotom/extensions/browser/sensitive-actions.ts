// Sensitive-action confirmation on the Pi side (T21).
//
// Three triggers are known without asking the relay — `upload`, accepting a
// `beforeunload` dialog, and (for future devtools work) `evaluate`. The relay reports the
// rest (`needs-confirmation`) after probing the target, so the wordlist lives in
// `chrome-extension/sensitive-actions.js` and is not duplicated here.
//
// Nothing here decides *whether* an action is sensitive on its own authority: the relay's
// probe is the source of truth for target names, and this module only decides how the
// answer is collected and whether the local development escape hatch applies.

import { isLocalOriginV1 } from "./browser-policy.ts";

export const SENSITIVE_CONFIRM_ENV_V1 = "ROTOM_BROWSER_CONFIRM" as const;
/** The only accepted value; anything else leaves confirmation on. */
export const AUTO_APPROVE_LOCALHOST_V1 = "auto-approve-localhost" as const;

export type SensitiveReasonV1 = "payment-form" | "sensitive-name" | "upload" | "beforeunload" | "evaluate";

/**
 * `ROTOM_BROWSER_CONFIRM=auto-approve-localhost` exists so e2e and local development do
 * not click through a dialog on every submit. It must do nothing for a non-local origin:
 * the switch is a convenience for the operator's own machine, not a site exemption.
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
	// consequential, so both need confirmation.
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
