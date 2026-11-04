import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../src/broker/protocol.ts";
import { UnsafePathError } from "../src/broker/paths.ts";
import { classifyApp, HIGH_RISK_WARNING } from "../src/policy/catalog.ts";
import { createPolicyGate } from "../src/policy/gate.ts";
import { excludeHostRoots, isHostRoot, resolveHostApp } from "../src/policy/host-exclusion.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";
import { matchSensitiveAction } from "../src/policy/sensitive.ts";
import { ACTION_TIERS, requiredTier, tierAllows } from "../src/policy/tiers.ts";

function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "rotom-cu-policy-"));
}

function store(root: string, project?: Record<string, unknown>): PolicyStore {
	const projectPath = path.join(root, "project", "computer-use.json");
	if (project) {
		mkdirSync(path.dirname(projectPath), { recursive: true });
		writeFileSync(projectPath, JSON.stringify(project));
	}
	return new PolicyStore({ globalPath: path.join(root, "home", "policy.json"), projectPath });
}

test("action tiers form the full view/click/full matrix", () => {
	const viewActions = Object.entries(ACTION_TIERS).filter(([, tier]) => tier === "view").map(([name]) => name);
	const clickActions = Object.entries(ACTION_TIERS).filter(([, tier]) => tier === "click").map(([name]) => name);
	const fullActions = Object.entries(ACTION_TIERS).filter(([, tier]) => tier === "full").map(([name]) => name);
	assert.ok(viewActions.length > 0 && clickActions.length > 0 && fullActions.length > 0);

	for (const name of viewActions) {
		assert.equal(tierAllows("view", name), true, `view app may ${name}`);
		assert.equal(tierAllows("click", name), true);
		assert.equal(tierAllows("full", name), true);
	}
	for (const name of clickActions) {
		assert.equal(tierAllows("view", name), false, `view app must not ${name}`);
		assert.equal(tierAllows("click", name), true);
		assert.equal(tierAllows("full", name), true);
	}
	for (const name of fullActions) {
		assert.equal(tierAllows("view", name), false, `view app must not ${name}`);
		assert.equal(tierAllows("click", name), false, `click app must not ${name}`);
		assert.equal(tierAllows("full", name), true);
	}

	// A batch takes the strongest tier of its parts, and unknown actions fail closed.
	assert.equal(requiredTier("press"), "click");
	assert.equal(requiredTier("press+setText"), "full");
	assert.equal(requiredTier("press+click"), "click");
	assert.equal(tierAllows("click", "brand_new_action"), false);
	assert.equal(tierAllows("full", "brand_new_action"), true);
	assert.equal(tierAllows("click", undefined), false);
});

test("app catalogue maps the categories PLAN §7 names", () => {
	assert.equal(classifyApp({ bundleId: "com.google.Chrome" }).tier, "full", "browsers are full by D2");
	assert.equal(classifyApp({ appName: "Safari" }).id, "browser");
	assert.equal(classifyApp({ bundleId: "com.jetbrains.intellij" }).tier, "click");
	assert.equal(classifyApp({ appName: "IntelliJ IDEA" }).warning, HIGH_RISK_WARNING);
	assert.equal(classifyApp({ bundleId: "com.apple.Terminal" }).tier, "click");
	assert.equal(classifyApp({ appName: "Finder" }).tier, "click");
	assert.equal(classifyApp({ bundleId: "com.apple.finder" }).id, "finder");
	assert.equal(classifyApp({ appName: "System Settings" }).id, "system-settings");
	assert.equal(classifyApp({ appName: "1Password" }).id, "password-manager");
	assert.equal(classifyApp({ bundleId: "com.apple.Stocks" }).tier, "view", "trading stays observe-only");
	assert.equal(classifyApp({ appName: "招商银行" }).tier, "view");
	assert.equal(classifyApp({ appName: "TextEdit" }).tier, "full", "unknown apps keep the default tier");
});

test("sensitive action rules match both language families and ignore neutral labels", () => {
	for (const label of ["Delete", "Remove item", "Discard", "Send", "Submit order", "Pay now", "Place order", "Change Password", "删除", "发送", "提交订单", "支付", "修改密码", "登录"]) {
		assert.ok(matchSensitiveAction({ name: "press", label }), `expected sensitive match for ${label}`);
	}
	for (const label of ["Cancel", "取消", "Settings", "New document", "Close", ""]) {
		assert.equal(matchSensitiveAction({ name: "press", label }), undefined, `expected no match for ${JSON.stringify(label)}`);
	}
	assert.equal(matchSensitiveAction({ name: "press" }), undefined);
});

test("policy file is private, refuses symlinks, and project files can only tighten", () => {
	const root = tempRoot();
	try {
		const policy = store(root);
		policy.allowApp({ bundleId: "com.google.Chrome" }, "full");
		const filePath = policy.globalPath;
		assert.equal(statSync(filePath).mode & 0o777, 0o600);
		assert.equal(statSync(path.dirname(filePath)).mode & 0o777, 0o700);
		assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).apps, { "com.google.Chrome": "full" });

		// Project may narrow a global grant...
		const tightening = store(root, { apps: { "com.google.Chrome": "view" } });
		assert.equal(tightening.lookup({ bundleId: "com.google.Chrome" }, "chrome"), "view");
		// ...but never widen it, and never lift a deny.
		const widening = store(root, { apps: { "com.google.Chrome": "full", "com.apple.Stocks": "deny" } });
		assert.equal(widening.lookup({ bundleId: "com.apple.Stocks" }, "stocks"), "deny");
		// A project cannot introduce a grant that the user never made.
		const grantRoot = tempRoot();
		const projectGrantOnly = store(grantRoot, { apps: { "com.example.Unknown": "full" } });
		assert.equal(projectGrantOnly.lookup({ bundleId: "com.example.Unknown" }, "unknown"), undefined);
		rmSync(grantRoot, { recursive: true, force: true });
		// A project deny still wins after the user grants the app globally.
		widening.allowApp({ bundleId: "com.apple.Stocks" }, "full");
		assert.equal(widening.lookup({ bundleId: "com.apple.Stocks" }, "stocks"), "deny");

		// A global deny cannot be widened by "always allow".
		const deniedRoot = tempRoot();
		mkdirSync(path.join(deniedRoot, "home"), { recursive: true });
		writeFileSync(path.join(deniedRoot, "home", "policy.json"), JSON.stringify({ v: 1, apps: { "com.example.Bank": "deny" } }));
		const deniedStore = new PolicyStore({ globalPath: path.join(deniedRoot, "home", "policy.json"), projectPath: path.join(deniedRoot, "none.json") });
		assert.throws(() => deniedStore.allowApp({ bundleId: "com.example.Bank" }, "full"), /denied by policy/);
		rmSync(deniedRoot, { recursive: true, force: true });

		// A symlinked policy file is refused instead of followed.
		const linkedRoot = tempRoot();
		const realFile = path.join(linkedRoot, "real.json");
		writeFileSync(realFile, JSON.stringify({ v: 1, apps: {} }));
		chmodSync(realFile, 0o600);
		mkdirSync(path.join(linkedRoot, "home"), { recursive: true });
		const linkPath = path.join(linkedRoot, "home", "policy.json");
		symlinkSync(realFile, linkPath);
		const linked = new PolicyStore({ globalPath: linkPath, projectPath: path.join(linkedRoot, "none.json") });
		assert.throws(() => linked.effective(), (error: unknown) => error instanceof UnsafePathError);
		assert.throws(() => linked.allowApp({ bundleId: "com.apple.Safari" }, "full"), (error: unknown) => error instanceof UnsafePathError);
		rmSync(linkedRoot, { recursive: true, force: true });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host application is resolved from the pid chain and excluded from roots", () => {
	const apps = [
		{ pid: 100, appName: "iTerm2", bundleId: "com.googlecode.iterm2" },
		{ pid: 200, appName: "IntelliJ IDEA", bundleId: "com.jetbrains.intellij" },
		{ pid: 300, appName: "Safari", bundleId: "com.apple.Safari" },
	];
	const host = resolveHostApp(apps, [200, 100, 1]);
	assert.deepEqual(host, { pid: 200, appName: "IntelliJ IDEA", bundleId: "com.jetbrains.intellij" });
	assert.equal(resolveHostApp(apps, [999, 998]), undefined);

	const roots = [
		{ pid: 200, appName: "IntelliJ IDEA", bundleId: "com.jetbrains.intellij" },
		{ pid: 201, appName: "IntelliJ IDEA", bundleId: "com.jetbrains.intellij" },
		{ pid: 300, appName: "Safari", bundleId: "com.apple.Safari" },
	];
	const kept = excludeHostRoots(roots, host);
	assert.equal(kept.length, 1, "every window of the host bundle is excluded");
	assert.equal(kept[0].pid, 300);
	assert.equal(isHostRoot({ pid: 42, appName: "iterm2" }, host), false);
	assert.equal(isHostRoot({ pid: 100, appName: "iTerm2" }, host), false, "pid-only match against the resolved host");
});

test("the policy gate refuses by tier, asks for unknown apps, and forces a card for sensitive labels", () => {
	const root = tempRoot();
	try {
		const policy = store(root, { apps: { "com.apple.Stocks": "deny" } });
		const gate = createPolicyGate({ store: policy });

		const unknownApp = gate.check({ agentId: "a", resourceKey: "desktop-pid:1", app: { appName: "TextEdit", bundleId: "com.apple.TextEdit" }, action: { name: "press" } });
		assert.equal(unknownApp.tier, "full");
		assert.equal(unknownApp.requiresApproval, true, "an app without a standing grant needs a decision");

		const ide = gate.check({ agentId: "a", resourceKey: "desktop-pid:2", app: { bundleId: "com.jetbrains.intellij" }, action: { name: "press" } });
		assert.equal(ide.tier, "click");
		assert.equal(ide.warning, HIGH_RISK_WARNING);
		const ideTyping = gate.check({ agentId: "a", resourceKey: "desktop-pid:2", app: { bundleId: "com.jetbrains.intellij" }, action: { name: "typeText" } });
		assert.ok(ideTyping.denied, "click tier refuses text input");

		const deniedApp = gate.check({ agentId: "a", resourceKey: "desktop-pid:3", app: { bundleId: "com.apple.Stocks" }, action: { name: "observe_ui" } });
		assert.ok(deniedApp.denied);

		policy.allowApp({ bundleId: "com.apple.TextEdit" }, "full");
		const granted = gate.check({ agentId: "a", resourceKey: "desktop-pid:1", app: { bundleId: "com.apple.TextEdit" }, action: { name: "press" } });
		assert.equal(granted.requiresApproval, false, "a standing grant needs no card");
		const sensitive = gate.check({ agentId: "a", resourceKey: "desktop-pid:1", app: { bundleId: "com.apple.TextEdit" }, action: { name: "press", label: "删除" } });
		assert.equal(sensitive.requiresApproval, true, "sensitive labels always ask");
		assert.notEqual(sensitive.cacheKey, granted.cacheKey, "a sensitive approval does not cache the plain grant");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

assert.ok(DEFAULT_APPROVAL_TIMEOUT_MS > 0);
assert.ok(lstatSync(tmpdir()).isDirectory());
