const MIN_RATIO_SAMPLE = 10;

function ratio(numerator, denominator) {
	return denominator === 0 ? null : numerator / denominator;
}

/** Count labeled rows without binding signal names to any rule registry. */
export function computeAgreement(rows) {
	const evaluated = rows.filter((row) => row.verdict === "pass" || row.verdict === "fail");
	for (const row of evaluated) {
		if (
			typeof row.sessionId !== "string" ||
			!Array.isArray(row.categories) || row.categories.some((category) => typeof category !== "string") ||
			!row.signals || typeof row.signals !== "object" || Array.isArray(row.signals) ||
			Object.values(row.signals).some((status) => !["hit", "clear", "unknown"].includes(status))
		) throw new Error("Invalid agreement row");
	}
	const names = [...new Set(evaluated.flatMap((row) => Object.keys(row.signals)))].sort();
	const categoryNames = [...new Set(evaluated.flatMap((row) => row.categories))].sort();
	const signals = Object.fromEntries(names.map((name) => [
		name, { tp: 0, fp: 0, fn: 0, tn: 0, unknown: 0, precision: null, recall: null, specificity: null },
	]));
	const reviewSessions = Object.fromEntries(names.map((name) => [name, { fp: [], fn: [] }]));
	const categories = Object.fromEntries(categoryNames.map((name) => [
		name, { fail: 0, hits: Object.fromEntries(names.map((signal) => [signal, 0])) },
	]));
	for (const row of evaluated) {
		for (const name of names) {
			const status = Object.hasOwn(row.signals, name) ? row.signals[name] : "unknown";
			if (status === "unknown") { signals[name].unknown++; continue; }
			const cell = status === "hit" ? (row.verdict === "fail" ? "tp" : "fp") : (row.verdict === "fail" ? "fn" : "tn");
			signals[name][cell]++;
			if (cell === "fp" || cell === "fn") reviewSessions[name][cell].push(row.sessionId);
		}
		if (row.verdict !== "fail") continue;
		for (const category of new Set(row.categories)) {
			categories[category].fail++;
			for (const name of names) if (Object.hasOwn(row.signals, name) && row.signals[name] === "hit") categories[category].hits[name]++;
		}
	}
	for (const counts of Object.values(signals)) {
		counts.precision = ratio(counts.tp, counts.tp + counts.fp);
		counts.recall = ratio(counts.tp, counts.tp + counts.fn);
		counts.specificity = ratio(counts.tn, counts.tn + counts.fp);
	}
	return {
		totalRows: rows.length,
		evaluatedRows: evaluated.length,
		ignoredVerdicts: rows.length - evaluated.length,
		signals,
		categories,
		uncoveredCategories: categoryNames.filter((name) => Object.values(categories[name].hits).every((count) => count === 0)),
		reviewSessions,
	};
}

function markdown(value) {
	return String(value)
		.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
		.replace(/[\\`*_{}[\]()|>]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function table(headers, rows) {
	return [headers, headers.map(() => "---"), ...rows].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

function formatRatio(value, denominator) {
	if (value === null) return "n/a";
	return `${(value * 100).toFixed(2)}%${denominator < MIN_RATIO_SAMPLE ? " (n<10)" : ""}`;
}

/** Render private review IDs only to the Markdown report, never a stdout summary. */
export function renderAgreementMarkdown(result) {
	const names = Object.keys(result.signals);
	const signalRows = names.map((name) => {
		const { tp, fp, fn, tn, unknown, precision, recall, specificity } = result.signals[name];
		return [markdown(name), tp, fp, fn, tn, unknown, formatRatio(precision, tp + fp), formatRatio(recall, tp + fn), formatRatio(specificity, tn + fp)];
	});
	const categoryRows = Object.entries(result.categories).map(([name, counts]) => [markdown(name), counts.fail, ...names.map((signal) => counts.hits[signal])]);
	const review = names.map((name) => `### ${markdown(name)}\n\n- FP：${result.reviewSessions[name].fp.map(markdown).join(", ") || "(无)"}\n- FN：${result.reviewSessions[name].fn.map(markdown).join(", ") || "(无)"}`);
	return [
		"# 信号与人工标注一致性",
		`输入 ${result.totalRows} 行；有效 ${result.evaluatedRows} 行；忽略 verdict ${result.ignoredVerdicts} 行。`,
		"unknown 不参与四格和比例；(n<10) 表示分母不足 10，不据此下结论。",
		"## 信号统计",
		table(["信号", "TP", "FP", "FN", "TN", "unknown", "precision", "recall", "specificity"], signalRows),
		"## 类别 × 信号",
		table(["类别", "fail 会话数", ...names.map(markdown)], categoryRows),
		"## 没有信号 hit 的类别",
		result.uncoveredCategories.map((name) => `- ${markdown(name)}`).join("\n") || "(无)",
		"## FP / FN 会话",
		review.join("\n\n") || "(无)",
	].join("\n\n") + "\n";
}
