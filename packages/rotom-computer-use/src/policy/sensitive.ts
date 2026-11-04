import type { ActionIntent } from "../broker/protocol.ts";

/**
 * High-impact action labels.
 *
 * A match does not block the action: it forces an approval card before delivery,
 * even for an app the user already granted this session. Patterns cover the
 * Chinese and English labels the fixtures and real apps use.
 */
export interface SensitiveRule {
	id: string;
	description: string;
	patterns: RegExp[];
}

export const SENSITIVE_RULES: SensitiveRule[] = [
	{
		id: "delete",
		description: "deletes or removes something",
		patterns: [/\bdelete\b/i, /\bremove\b/i, /\bdiscard\b/i, /\btrash\b/i, /删除/, /移除/, /清空/, /丢弃/],
	},
	{
		id: "send",
		description: "sends a message or submits",
		patterns: [/\bsend\b/i, /\bsubmit\b/i, /\bpublish\b/i, /\bpost\b/i, /发送/, /提交/, /发布/],
	},
	{
		id: "pay",
		description: "moves money or places an order",
		patterns: [/\bpay\b/i, /\bpurchase\b/i, /\bbuy\b/i, /\bcheckout\b/i, /\bplace order\b/i, /\btransfer\b/i, /支付/, /付款/, /购买/, /下单/, /转账/, /提交订单/],
	},
	{
		id: "credential",
		description: "changes a password, key or account security setting",
		patterns: [/\bpassword\b/i, /\bpassphrase\b/i, /\bapi key\b/i, /\bsign out\b/i, /\bsign in\b/i, /密码/, /口令/, /密钥/, /登录/, /退出登录/],
	},
	{
		id: "permission",
		description: "changes a system permission or security setting",
		patterns: [/\ballow\b/i, /\bprivacy\b/i, /\bsecurity\b/i, /\bfull disk access\b/i, /允许/, /隐私/, /安全/, /权限/],
	},
];

export interface SensitiveMatch {
	rule: SensitiveRule;
	label: string;
}

export function matchSensitiveAction(action: ActionIntent | undefined): SensitiveMatch | undefined {
	const label = action?.label?.trim();
	if (!label) return undefined;
	for (const rule of SENSITIVE_RULES) {
		if (rule.patterns.some((pattern) => pattern.test(label))) return { rule, label };
	}
	return undefined;
}

export function describeSensitiveMatch(match: SensitiveMatch): string {
	return `This control ${match.rule.description}: ${JSON.stringify(match.label)}.`;
}
