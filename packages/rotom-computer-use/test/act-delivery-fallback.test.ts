import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptWithDeliveryFallback } from "../src/tools/act-delivery.ts";
import { buildActRequest } from "../src/tools/act-request.ts";
import type { NativeInputDelivery, PlatformActRequest, PlatformDeliveryPolicy } from "../src/platform/types.ts";

const typeText = { action: "typeText", params: { text: "probe" }, target: { ref: "e7" } };

/** Records what reached the "backend" and answers like the helper does. */
function fakeBackend(answers: Array<"worked" | Error>) {
	const seen: Array<{ policy: PlatformDeliveryPolicy; delivery: NativeInputDelivery | undefined; requireTransport: unknown }> = [];
	let index = 0;
	return {
		seen,
		async act(request: PlatformActRequest) {
			seen.push({ policy: request.policy, delivery: request.params.delivery, requireTransport: (request.params as { requireTransport?: unknown }).requireTransport });
			const answer = answers[Math.min(index, answers.length - 1)];
			index += 1;
			if (answer instanceof Error) throw answer;
			return { outcome: answer } as const;
		},
	};
}

function request(policy: PlatformDeliveryPolicy, delivery: NativeInputDelivery) {
	return buildActRequest({
		lookId: "look-1",
		pid: 4242,
		cursorAgentId: "session:test",
		action: typeText,
		policy,
		delivery,
	});
}

test("an unavailable L2 symbol repeats the same background action over pid posting", async () => {
	// Review G4: IntelliJ is on the compatibility list, so its background actions now
	// really ask for L2. A build without the private symbol must not escalate to the
	// foreground; it repeats the action over pid posting, which touches nothing.
	const backend = fakeBackend([Object.assign(new Error("Targeted background delivery is unavailable on this macOS build"), { code: "l2_unavailable" }), "worked"]);
	const policy: PlatformDeliveryPolicy = "background";
	const result = await attemptWithDeliveryFallback({
		mayFallBack: true,
		request: (override) => request(policy, override ?? "l2"),
		act: (built) => backend.act(built),
	});
	assert.equal(result.result.outcome, "worked");
	assert.equal(result.pidFallback, "l2_unavailable");
	assert.equal(backend.seen.length, 2);
	assert.equal(backend.seen[0]?.delivery, "l2");
	assert.equal(backend.seen[1]?.policy, "background", "the retry stays in the background");
	assert.equal(backend.seen[1]?.delivery, "pid");
	assert.equal(backend.seen[1]?.requireTransport, undefined, "the retry is not a transport pin");
});

test("a foreground requirement is never retried as pid posting", async () => {
	const backend = fakeBackend([Object.assign(new Error("Web content requires pointer input"), { code: "foreground_required" })]);
	await assert.rejects(
		attemptWithDeliveryFallback({ mayFallBack: true, request: () => request("background", "l2"), act: (built) => backend.act(built) }),
		/Web content requires pointer input/,
	);
	assert.equal(backend.seen.length, 1, "the caller decides about the foreground, not this helper");
});

test("headless never retries, whatever the code", async () => {
	const backend = fakeBackend([Object.assign(new Error("no symbol"), { code: "l2_unavailable" })]);
	await assert.rejects(
		attemptWithDeliveryFallback({ mayFallBack: false, request: () => request("background_text", "pid"), act: (built) => backend.act(built) }),
		/no symbol/,
	);
	assert.equal(backend.seen.length, 1);
});

test("other failures are not swallowed", async () => {
	const backend = fakeBackend([Object.assign(new Error("stale ref"), { code: "stale_ref" })]);
	await assert.rejects(
		attemptWithDeliveryFallback({ mayFallBack: true, request: () => request("background", "pid"), act: (built) => backend.act(built) }),
		/stale ref/,
	);
});
