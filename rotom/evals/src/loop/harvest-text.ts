import type { Block } from "./harvest-tree.ts";

// What the human wrote: strip injected templates, then decide whether a message is a
// correction, a bare continue, or the same request again. Precision over recall.

export const EXCERPT_CHARS = 240;

// Strong-ish phrases only; precision over recall, since every hit costs triage time.
const CORRECTION_PATTERNS: readonly RegExp[] = [
	/^(不对|不是|错了|搞错|理解错)/u,
	/(不对[，,。!！]|不是这样|你搞错|你理解错|理解错了|搞错了)/u,
	/(你没有|你没|你漏了|漏掉了|你忘了|你又)/u,
	/(我说的是|我是说|我的意思是|我让你|不是让你|我要的是|我没让你|我没有让你)/u,
	/(为什么没|为什么不|为什么又|怎么又|又错|还是不行|还是没|还是错)/u,
	/(别再|不要再|不要这样|不需要你|谁让你)/u,
	/\b(that'?s (wrong|not right|not what)|not what i (asked|meant|said|wanted))\b/iu,
	/\b(you (didn'?t|did not|forgot|missed|ignored)|i (said|asked|told you)|why did(n'?t)? you|still (broken|failing|wrong|not working))\b/iu,
	/^(no[,.! ]|wrong\b|stop\b)/iu,
];

const BARE_CONTINUE = new Set([
	"继续", "继续吧", "继续做", "继续啊", "接着", "接着做", "接着来", "往下做", "下一步", "别停", "不要停", "然后呢", "继续执行", "go", "go on",
	"continue", "keep going", "proceed", "next", "carry on", "继续。", "继续!", "继续！",
]);

/** `/skill:<name>` expands into this block; only the text after it is what the user typed. */
const SKILL_BLOCK = /^<skill name="[^"]*" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/u;
/** `/goal resume` delivers the goal contract as a user message; the text is injected, not typed. */
const GOAL_RESUME_BLOCK = /^The user explicitly resumed the paused \/goal\.[\s\S]*$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Block => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** The part of a user message the human wrote; a skill template is injected text, not a request. */
export function humanText(text: string): string {
	const match = text.match(SKILL_BLOCK);
	if (match) return (match[1] ?? "").trim();
	return GOAL_RESUME_BLOCK.test(text) ? "" : text;
}

export function clip(text: string, fromEnd = false): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	if (flat.length <= EXCERPT_CHARS) return flat;
	return fromEnd ? `…${flat.slice(-EXCERPT_CHARS)}` : `${flat.slice(0, EXCERPT_CHARS)}…`;
}

export function normalized(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function bigrams(text: string): Set<string> {
	const result = new Set<string>();
	for (let index = 0; index < text.length - 1; index++) result.add(text.slice(index, index + 2));
	return result;
}

export function similarity(left: string, right: string): number {
	const a = bigrams(normalized(left));
	const b = bigrams(normalized(right));
	if (a.size === 0 || b.size === 0) return normalized(left) === normalized(right) ? 1 : 0;
	let shared = 0;
	for (const gram of a) if (b.has(gram)) shared++;
	return shared / (a.size + b.size - shared);
}

export function isCorrection(text: string): boolean {
	const head = text.trim().slice(0, 400);
	return head.length > 0 && CORRECTION_PATTERNS.some((pattern) => pattern.test(head));
}

export function isBareContinue(text: string): boolean {
	return BARE_CONTINUE.has(text.trim().toLowerCase().replace(/[。.!！~～]+$/u, "")) || BARE_CONTINUE.has(text.trim());
}
