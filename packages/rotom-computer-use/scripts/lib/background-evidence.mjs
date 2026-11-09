const MUTATING_BACKEND_METHODS = new Set([
	"act",
	"clipboardClear",
	"clipboardRestore",
	"clipboardSet",
	"focusWindow",
	"manageApps",
	"manageWindow",
]);
const MUTATING_HELPER_COMMANDS = new Set(["act", "actBatch", "focusWindow", "manageApps", "manageWindow"]);

/**
 * Measure background work without treating the operator's own input as a failure.
 * Every mutating call samples the frontmost app before and after it. A switch to a
 * run-owned process or the helper is ours and fails; any other switch is the user.
 */
export function createBackgroundEvidence({ backend, helper, record, ownedPids = new Set() }) {
	let active = false;
	let activityBefore;
	let helperPid;
	let cursorInvariant = false;
	let checkedActions = 0;
	const focusViolations = [];
	const userSwitches = [];

	const own = (pid) => {
		if (Number.isFinite(pid) && pid > 0) ownedPids.add(Math.trunc(pid));
	};
	const setHelperPid = (pid, invariants = []) => {
		helperPid = Number.isFinite(pid) && pid > 0 ? Math.trunc(pid) : undefined;
		cursorInvariant = Array.isArray(invariants) && invariants.includes("background-delivery-no-cursor-warp");
		if (!helperPid) focusViolations.push("helper pid unavailable: helper focus cannot be ruled out");
	};
	const isOwned = (pid) => ownedPids.has(pid) || pid === helperPid;

	async function sampleFrontmost(label) {
		try {
			const frontmost = await backend.getFrontmost();
			if (!Number.isFinite(frontmost?.pid)) focusViolations.push(`${label}: frontmost app was unavailable`);
			return frontmost;
		} catch (error) {
			focusViolations.push(`${label}: frontmost read failed (${error instanceof Error ? error.message : String(error)})`);
			return undefined;
		}
	}

	async function measure(label, operation, { launchRequest = undefined } = {}) {
		if (!active) return await operation();
		const before = await sampleFrontmost(`${label} before`);
		let value;
		let failure;
		try {
			value = await operation();
			if (launchRequest && Number.isFinite(value?.pid) && value?.alreadyRunning !== true) own(value.pid);
		} catch (error) {
			failure = error;
		}
		const after = await sampleFrontmost(`${label} after`);
		checkedActions += 1;
		const requestedBundle = launchRequest?.bundleId;
		const launchedOwnApp = requestedBundle && after?.bundleId === requestedBundle;
		if (before && isOwned(before.pid)) {
			focusViolations.push(`${label}: began with ${before.appName ?? "?"}(${before.pid}) frontmost`);
		}
		if (after && (isOwned(after.pid) || launchedOwnApp)) {
			focusViolations.push(`${label}: ${before?.appName ?? "?"}(${before?.pid ?? "?"}) → ${after.appName ?? "?"}(${after.pid})`);
		} else if (before && after && before.pid !== after.pid) {
			userSwitches.push(`${before.appName ?? "?"}(${before.pid}) → ${after.appName ?? "?"}(${after.pid})`);
		}
		if (failure) throw failure;
		return value;
	}

	const wrappedBackend = new Proxy(backend, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof property !== "string" || typeof value !== "function") return value;
			if (!MUTATING_BACKEND_METHODS.has(property)) return value.bind(target);
			return (...args) => measure(`backend.${property}`, () => value.apply(target, args), {
				launchRequest: property === "manageApps" && args[0]?.mode === "launch" ? args[0] : undefined,
			});
		},
	});
	const wrappedHelper = new Proxy(helper, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property !== "command" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
			return (command, ...args) => MUTATING_HELPER_COMMANDS.has(command)
				? measure(`helper.${command}`, () => value.call(target, command, ...args))
				: value.call(target, command, ...args);
		},
	});

	async function start() {
		if (!helperPid && !focusViolations.some((item) => item.startsWith("helper pid unavailable"))) focusViolations.push("helper pid unavailable: helper focus cannot be ruled out");
		activityBefore = await helper.command("userActivity", {}).catch(() => undefined);
		active = true;
	}

	async function finish() {
		active = false;
		const activityAfter = await helper.command("userActivity", {}).catch(() => undefined);
		const finalFrontmost = await sampleFrontmost("finish");
		if (finalFrontmost && isOwned(finalFrontmost.pid)) focusViolations.push(`finish: ${finalFrontmost.appName ?? "?"}(${finalFrontmost.pid}) remained frontmost`);
		const before = Number(activityBefore?.agentHidEventCount);
		const after = Number(activityAfter?.agentHidEventCount);
		const delta = after - before;
		const agentResult = Number.isFinite(delta) && delta === 0 ? "pass" : "fail";
		record("background", "agent HID events", agentResult, `agentHidEvents ${Number.isFinite(before) ? before : "?"} → ${Number.isFinite(after) ? after : "?"} (${Number.isFinite(delta) ? (delta >= 0 ? `+${delta}` : String(delta)) : "?"})`);
		record("background", "focus taken", focusViolations.length === 0 ? "pass" : "fail", focusViolations.length === 0
			? `${checkedActions} actions checked; user switches=${userSwitches.length}`
			: focusViolations.join("; "));
		record("background", "cursor warped", cursorInvariant ? "pass" : "fail", cursorInvariant
			? "helper invariant: background-delivery-no-cursor-warp"
			: "helper did not report background-delivery-no-cursor-warp");
		return { activityBefore, activityAfter, focusViolations, userSwitches };
	}

	return { backend: wrappedBackend, helper: wrappedHelper, finish, measure, own, setHelperPid, start };
}
