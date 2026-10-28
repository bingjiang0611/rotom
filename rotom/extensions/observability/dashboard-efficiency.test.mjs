import assert from "node:assert/strict";
import test from "node:test";
import { dashboardRoute, efficiencyRates, mergeEfficiencyBuckets, summarizeEfficiency } from "./dashboard.mjs";
import { span } from "./dashboard-test-fixtures.mjs";


const OP = "op".padEnd(16, "0");
const OP2 = "op2".padEnd(16, "0");

function opRecords(spanId, { status = "ok", provider = "qoder", model = "ultimate", thinking = "low", cost = 0.02, totalTokens = 1000, tools = [], groups } = {}) {
	const requestId = `req${spanId}`.slice(0, 16).padEnd(16, "r");
	const providerAttrs = {
		"pi.ai.provider": provider, "pi.ai.model": model, "pi.ai.thinking_level": thinking,
		"pi.usage.total_tokens": totalTokens, ...(cost !== null ? { "pi.usage.cost": cost } : {}),
		...(groups ? { "pi.tools.deferred_groups": groups } : {}),
	};
	const out = [
		span("span_start", { spanId, name: "pi.agent.operation" }),
		span("span_start", { spanId: requestId, parentSpanId: spanId, name: "pi.ai.request" }),
		span("span_end", { spanId: requestId, parentSpanId: spanId, name: "pi.ai.request", status: "ok", attributes: providerAttrs }),
	];
	tools.forEach((tool, index) => {
		const toolId = `tool${spanId}${index}`.slice(0, 16).padEnd(16, "t");
		out.push(span("span_end", { spanId: toolId, parentSpanId: spanId, name: "pi.tool.execute", status: tool.status ?? "ok", attributes: { "pi.tool.name": tool.name ?? "bash", ...(tool.group ? { "pi.tool.capability_group": tool.group } : {}), ...(tool.faultSide ? { "pi.tool.fault_side": tool.faultSide } : {}), ...(tool.outcome ? { "pi.tool.outcome": tool.outcome } : {}) } }));
	});
	out.push(span("span_end", { spanId, name: "pi.agent.operation", status }));
	return out;
}

test("route derives from qoder catalog model id, not a copied list", () => {
	assert.equal(dashboardRoute("qoder", "ultimate"), "qoder-cosy");
	assert.equal(dashboardRoute("qoder", "smodel"), "qoder-cosy");
	assert.equal(dashboardRoute("qoder", "claude-sonnet"), "qoder-direct");
	assert.equal(dashboardRoute("qoder-experimental", "ultimate"), "qoder-cosy", "historical traces retain their route");
	assert.equal(dashboardRoute("cc-switch", "claude-opus-5"), "n/a");
	assert.equal(dashboardRoute("", "x"), "unknown");
	assert.equal(dashboardRoute("qoder", ""), "unknown");
});

test("efficiency splits successes by provider/model/route/thinking and attributes subagent use", () => {
	const { buckets } = summarizeEfficiency([
		...opRecords(OP, { model: "ultimate", tools: [{ name: "subagent", group: "subagent" }, { name: "bash" }] }),
		...opRecords(OP2, { model: "claude-sonnet" }),
	]);
	const cosy = buckets.find((bucket) => bucket.route === "qoder-cosy");
	const direct = buckets.find((bucket) => bucket.route === "qoder-direct");
	assert.equal(cosy.subagentUsed, true);
	assert.equal(cosy.thinkingLevel, "low");
	assert.equal(direct.subagentUsed, false);
	assert.equal(cosy.successCount, 1);
	assert.equal(direct.successCount, 1);
});

test("cost per success stays null when any operation in the bucket reported no price", () => {
	const priced = mergeEfficiencyBuckets([summarizeEfficiency(opRecords(OP, { cost: 0.02, totalTokens: 1000 }))]).buckets[0];
	assert.equal(priced.costPerSuccessUsd, 0.02);
	assert.equal(priced.tokensPerSuccess, 1000);
	assert.equal(priced.pricingReason, "reported");

	// Qoder's $0 placeholder must not read as "free": no positive cost anywhere.
	const placeholder = mergeEfficiencyBuckets([summarizeEfficiency(opRecords(OP, { cost: 0, totalTokens: 1000 }))]).buckets[0];
	assert.equal(placeholder.costPerSuccessUsd, null);
	assert.equal(placeholder.tokensPerSuccess, 1000);
	assert.equal(placeholder.pricingReason, "not-reported");
});

test("failed and unknown operations count spend but not success, and never divide by zero", () => {
	const { buckets } = summarizeEfficiency([
		...opRecords(OP, { status: "ok", cost: 0.01, totalTokens: 500 }),
		...opRecords(OP2, { status: "error", cost: 0.03, totalTokens: 700 }),
	]);
	const [merged] = mergeEfficiencyBuckets([{ buckets, truncated: false }]).buckets;
	assert.equal(merged.operationCount, 2);
	assert.equal(merged.successCount, 1);
	assert.equal(merged.errorCount, 1);
	// Numerator is total spend (0.04) over one success: a dead end is part of the bill.
	assert.equal(Math.round(merged.costPerSuccessUsd * 1000) / 1000, 0.04);
	assert.equal(merged.tokensPerSuccess, 1200);

	const zero = efficiencyRates({ successCount: 0, operationCount: 3, totalTokens: 900, costUsd: 0.09, costReportedOperationCount: 3 });
	assert.equal(zero.costPerSuccessUsd, null);
	assert.equal(zero.tokensPerSuccess, null);
});

test("mixed provider/model within one operation is labelled mixed, not last-writer", () => {
	const mixedRequestId = "reqMIXED00000000";
	const { buckets } = summarizeEfficiency([
		span("span_start", { spanId: OP, name: "pi.agent.operation" }),
		span("span_end", { spanId: "reqA0000000000000", parentSpanId: OP, name: "pi.ai.request", status: "ok", attributes: { "pi.ai.provider": "qoder", "pi.ai.model": "ultimate" } }),
		span("span_end", { spanId: mixedRequestId, parentSpanId: OP, name: "pi.ai.request", status: "ok", attributes: { "pi.ai.provider": "cc-switch", "pi.ai.model": "claude-opus-5" } }),
		span("span_end", { spanId: OP, name: "pi.agent.operation", status: "ok" }),
	]);
	assert.equal(buckets.length, 1);
	assert.equal(buckets[0].provider, "mixed");
	assert.equal(buckets[0].route, "mixed");
});

test("fault-side tallies roll up per bucket from evidence-gated tool spans", () => {
	const { buckets } = summarizeEfficiency(opRecords(OP, { tools: [
		{ name: "edit", faultSide: "model" },
		{ name: "bash", faultSide: "environment" },
		{ name: "bash", faultSide: "unknown" },
	] }));
	const [merged] = mergeEfficiencyBuckets([{ buckets, truncated: false }]).buckets;
	assert.equal(merged.faultModel, 1);
	assert.equal(merged.faultEnvironment, 1);
	assert.equal(merged.faultUnknown, 1);
	assert.equal(merged.faultHarness, 0);
});

test("tool-level unknown split separates lifecycle-incomplete from ran-but-unverified", () => {
	const { buckets } = summarizeEfficiency(opRecords(OP, { tools: [
		{ name: "bash", status: "unknown", outcome: "incomplete" },
		{ name: "edit", status: "unknown", outcome: "incomplete" },
		{ name: "write", status: "unknown", outcome: "unknown_outcome" },
		{ name: "bash", status: "ok" },
	] }));
	const [merged] = mergeEfficiencyBuckets([{ buckets, truncated: false }]).buckets;
	assert.equal(merged.toolIncomplete, 2, "superseded / torn-down tools are lifecycle-incomplete, not model failures");
	assert.equal(merged.toolUnverified, 1, "a returned-but-unverified result is the derailment signal");
	// The split is a distinct axis from fault side: incomplete tools carry no side.
	assert.equal(merged.faultModel + merged.faultEnvironment + merged.faultHarness + merged.faultUnknown, 0);
});
