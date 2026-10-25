import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

const copy = {
	question: "满意吗？ y 满意 / n 不满意 / s 跳过 / o 看完整卡片 / q 退出 > ",
	reason: "一句话说哪里不对（回车跳过）> ",
	header: (index, total, summary) => `[${index}/${total}] ${summary.started} · ${summary.minutes} 分钟 · 工具 ${summary.tools} 次 · 出错 ${summary.errors} 次`,
	request: (value) => `你的请求：${value}`,
	hits: (value) => `规则提示：${value}`,
	final: (value) => `最终回复：${value}`,
	finished: (counts) => `本次 pass ${counts.pass} / fail ${counts.fail} / 跳过 ${counts.skipped}，还剩 ${counts.remaining} 张未标注，损坏 ${counts.damaged} 张`,
};

function oneLine(value, maximum) {
	const text = stripVTControlCharacters(value).replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
	return Array.from(text).slice(0, maximum).join("") || "?";
}

/** Read the existing card format, not the original session or trace. */
export function extractSummary(card) {
	// Notes can contain Markdown headings; they are not conversation sections.
	const labelStart = card.lastIndexOf("\n<!-- label:begin -->");
	if (labelStart >= 0) card = card.slice(0, labelStart);
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(card)?.[1] ?? "";
	function field(name) {
		const value = new RegExp(`^${name}: (.+)$`, "m").exec(frontmatter)?.[1];
		if (value === undefined) return undefined;
		try { return JSON.parse(value); } catch { return undefined; }
	}
	function section(name, maximum) {
		const body = new RegExp(`^## ${name}\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(card)?.[1] ?? "";
		return oneLine(body.replace(/^> ?/gm, "").replace(/&(?:amp|lt);/g, (entity) => entity === "&amp;" ? "&" : "<"), maximum);
	}
	const started = field("started");
	const timestamp = typeof started === "string" ? Date.parse(started) : NaN;
	const date = new Date(timestamp);
	const pad = (value) => String(value).padStart(2, "0");
	const rawDuration = field("duration");
	const duration = typeof rawDuration === "string" ? /^(\d+(?:\.\d+)?)ms$/.exec(rawDuration) : null;
	const tools = field("tool_calls");
	const errors = field("tool_errors");
	const findings = field("findings");
	return {
		timestamp: Number.isFinite(timestamp) ? timestamp : -Infinity,
		started: Number.isFinite(timestamp) ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` : "?",
		minutes: duration && Number.isFinite(Number(duration[1])) ? Math.round(Number(duration[1]) / 60000) : "?",
		tools: Number.isInteger(tools) && tools >= 0 ? tools : "?",
		errors: errors && typeof errors === "object" && !Array.isArray(errors) && Object.values(errors).every((count) => Number.isInteger(count) && count >= 0)
			? Object.values(errors).reduce((sum, count) => sum + count, 0) : "?",
		hits: findings && typeof findings === "object" && !Array.isArray(findings)
			? Object.entries(findings).filter(([, status]) => status === "hit").map(([name]) => oneLine(name, 120)) : [],
		request: section("用户请求", 120),
		final: section("最终回复", 160),
	};
}

export function renderSummary(summary, index, total) {
	return [
		copy.header(index, total, summary),
		copy.request(summary.request),
		...(summary.hits.length ? [copy.hits(summary.hits.join("、"))] : []),
		copy.final(summary.final),
	].join("\n") + "\n";
}

/** Cards are already path-checked and label-validated by the filesystem caller. */
export async function runReview(cards, { limit, input, output, writeCard, damaged = 0 }) {
	const pending = cards.map((card) => ({ ...card, summary: extractSummary(card.content.toString("utf8")) }))
		.sort((a, b) => b.summary.timestamp - a.summary.timestamp || a.path.localeCompare(b.path));
	const selected = pending.slice(0, limit);
	const counts = { pass: 0, fail: 0, skipped: 0, remaining: pending.length, damaged };
	const reader = createInterface({ input, output, terminal: input.isTTY === true, crlfDelay: Infinity });
	const lines = reader[Symbol.asyncIterator]();
	let interrupted = false;
	reader.on("SIGINT", () => { interrupted = true; reader.close(); });
	async function ask(prompt) {
		if (interrupted) return undefined;
		if (input.isTTY === true) { reader.setPrompt(prompt); reader.prompt(); }
		else output.write(prompt);
		const answer = await lines.next();
		return interrupted || answer.done ? undefined : answer.value;
	}
	try {
		for (const [index, card] of selected.entries()) {
			if (interrupted) break;
			output.write(renderSummary(card.summary, index + 1, selected.length));
			let answer;
			while (true) {
				answer = (await ask(copy.question))?.trim().toLowerCase();
				if (answer === undefined || ["y", "n", "s", "q"].includes(answer)) break;
				if (answer === "o") output.write(`\n${JSON.stringify(card.path)}\n`);
			}
			if (answer === undefined || answer === "q") break;
			if (answer === "s") counts.skipped++;
			else {
				const note = answer === "n" ? await ask(copy.reason) : "";
				if (note === undefined) break;
				const verdict = answer === "y" ? "pass" : "fail";
				const block = `<!-- label:begin -->\nverdict: ${verdict}\ncategories:\nnote: ${note}\n<!-- label:end -->\n`;
				// Keep the prefix as bytes, including CRLF, Unicode, or non-UTF8 body bytes.
				await writeCard(card.path, Buffer.concat([card.content.subarray(0, card.labelStart), Buffer.from(block)]));
				counts[verdict]++;
				counts.remaining--;
			}
			output.write("\n");
		}
		output.write(`\n${copy.finished(counts)}\n`);
		return counts;
	} finally { reader.close(); }
}
