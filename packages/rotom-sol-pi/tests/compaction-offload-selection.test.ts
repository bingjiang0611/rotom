import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { offloadCandidate, offloadPlaceholderFor, selectOffloadCandidates } from "../src/sol-pi/extensions/observation-pack/offload.ts";
import { createObservation, THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { result } from "./compaction-offload-session.ts";

function body(message: AgentMessage): string {
 if (message.role !== "toolResult") return "";
 return message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

describe("compaction offload selection and placeholder", () => {
	it.each([[1536, false], [1537, true], [10240, true], [10241, false]])("selects UTF-8 boundary %i", (bytes, selected) => {
		const message = result(bytes as number);
		expect(!!offloadCandidate(message, "/unused")).toBe(selected);
	});
	it("uses UTF-8 bytes, complete lines and <=512 bytes; skips uneconomic or oversized headers", () => {
		const message = result();
		message.content = [{ type: "text", text: "中文行\n".repeat(300) }];
		const candidate = offloadCandidate(message, "/unused")!;
		expect(candidate.observation.bytes).toBe(3000);
		expect(Buffer.byteLength(candidate.placeholder)).toBeLessThanOrEqual(512);
		expect(candidate.placeholder).toContain('retrieve: call obs_recall with {"id":');
		expect(candidate.placeholder.split("next_offset\n")[1]).toMatch(/^(中文行\n)+$/u);
		expect(offloadPlaceholderFor({ ...candidate.observation, text: "x", bytes: 100 })).toBeUndefined();
		expect(offloadPlaceholderFor({ ...candidate.observation, toolName: "a".repeat(600) })).toBeUndefined();
	});
	it("excludes error, image, recall, reducer receipts, duplicates and offloaded calls", () => {
		const ordinary = result();
		const image = { ...ordinary, content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }] };
		const receipt = { ...ordinary, content: [{ type: "text" as const, text: "sol_pi_evidence_receipt_v1\n" + body(ordinary) }] };
		for (const message of [{ ...ordinary, isError: true }, image, receipt, result(8192, "recall", "obs_recall")]) {
			expect(offloadCandidate(message, "/unused")).toBeUndefined();
		}
		expect(selectOffloadCandidates([ordinary, ordinary], "/unused", new Set())).toHaveLength(1);
		expect(selectOffloadCandidates([ordinary], "/unused", new Set([ordinary.toolCallId]))).toHaveLength(0);
		expect(createObservation(ordinary, "/unused")).toBeUndefined();
		expect(createObservation(result(10241), "/unused")).toEqual(createObservation(result(10241), "/unused", THRESHOLD_BYTES));
	});
});
