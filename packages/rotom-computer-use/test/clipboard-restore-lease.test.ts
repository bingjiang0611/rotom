/**
 * The clipboard restore holds the clipboard lease (review Q5).
 *
 * A restore overwrites what the user sees, so it goes through the same serialization
 * as `clipboard set`: another agent holding `clipboard:system` wins, and the restore is
 * reported as skipped instead of being written anyway. The helper refuses a restore
 * without a token, so a "skip" is the only correct answer here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformClipboardSnapshot } from "../src/platform/types.ts";
import {
	RestoreLeaseUnavailableError,
	restoreWithLease,
	scheduleClipboardRestore,
} from "../src/tools/clipboard.ts";
import type { DesktopToolDeps } from "../src/tools/desktop-deps.ts";
import { LeaseUnavailableError, ResourceScheduler, type LeaseBroker } from "../src/runtime.ts";

const SNAPSHOT: PlatformClipboardSnapshot = {
	changeCount: 5,
	totalBytes: 4,
	items: [{ types: [{ type: "public.utf8-plain-text", dataBase64: Buffer.from("user").toString("base64") }] }],
};

/** A broker that refuses every acquire, as if another agent held the resource. */
function busyBroker(holder = "session:other"): LeaseBroker {
	return {
		async acquire() {
			throw new LeaseUnavailableError("resource_busy", "clipboard:system is held by another agent", {
				holder: { agentId: holder, remainingMs: 30_000 },
			});
		},
		async release() {},
		async refreshEpoch() {
			return 1;
		},
		holderOf() {
			return { agentId: holder, remainingMs: 30_000 };
		},
	};
}

function depsWith(scheduler: ResourceScheduler): DesktopToolDeps {
	return { scheduler: () => scheduler } as unknown as DesktopToolDeps;
}

test("a restore is skipped while another agent holds the clipboard lease", async () => {
	const written: string[] = [];
	const backend = {
		async clipboardRestore(snapshot: PlatformClipboardSnapshot) {
			written.push(snapshot.items[0].types[0].type);
			return { restored: true, changeCount: 6, items: 1 };
		},
	};
	const scheduler = new ResourceScheduler(busyBroker());

	await assert.rejects(
		() => restoreWithLease(depsWith(scheduler), backend as never, SNAPSHOT),
		(error: unknown) => error instanceof RestoreLeaseUnavailableError,
	);
	assert.deepEqual(written, [], "nothing may be written without the lease");
});

test("a restore under the lease names the clipboard resource and carries the token", async () => {
	const seen: Array<{ token: string; resourceKey: string }> = [];
	const backend = {
		async clipboardRestore(_snapshot: PlatformClipboardSnapshot, _signal: AbortSignal | undefined, lease: { token: string; resourceKey: string }) {
			seen.push(lease);
			return { restored: true, changeCount: 6, items: 1 };
		},
	};
	const broker: LeaseBroker = {
		async acquire() {
			return { leaseId: "lease-test-1", epoch: 3, token: "signed-token" };
		},
		async release() {},
		async refreshEpoch() {
			return 3;
		},
		holderOf() {
			return undefined;
		},
	};

	await restoreWithLease(depsWith(new ResourceScheduler(broker)), backend as never, SNAPSHOT);
	assert.deepEqual(seen, [{ token: "signed-token", resourceKey: "clipboard:system" }]);
});

test("the deferred restore reports lease_unavailable instead of restore_failed", async () => {
	const skips: string[] = [];
	let fired: (() => void) | undefined;
	scheduleClipboardRestore({
		snapshot: SNAPSHOT,
		writtenChangeCount: 6,
		restore: true,
		snapshotNow: async () => ({ ...SNAPSHOT, changeCount: 6 }),
		write: async () => {
			throw new RestoreLeaseUnavailableError();
		},
		onSkip: (reason) => skips.push(reason),
		setTimer: (callback) => {
			fired = callback;
			return 0 as unknown as ReturnType<typeof setTimeout>;
		},
	});
	fired?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(skips, ["lease_unavailable"]);
});
