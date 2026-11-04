/**
 * App catalogue: which tier an app gets by default, and whether its approval
 * card carries an extra warning.
 *
 * The catalogue is data, not a policy decision: a user's `policy.json` entry
 * overrides it, and a project file can only tighten it. Tier meanings come from
 * PLAN §7: `view` observes only, `click` allows pointer-free clicks on controls,
 * `full` adds text input, key presses and clipboard writes.
 */
export type AppTier = "view" | "click" | "full";

export const TIER_RANK: Record<AppTier, number> = { view: 0, click: 1, full: 2 };

export function strongerTier(left: AppTier, right: AppTier): AppTier {
	return TIER_RANK[left] >= TIER_RANK[right] ? left : right;
}

export function weakerTier(left: AppTier, right: AppTier): AppTier {
	return TIER_RANK[left] <= TIER_RANK[right] ? left : right;
}

export function isAppTier(value: unknown): value is AppTier {
	return value === "view" || value === "click" || value === "full";
}

export interface AppCategory {
	id: string;
	label: string;
	tier: AppTier;
	/** Shown on the approval card. Present for the high-risk categories. */
	warning?: string;
	bundleIds: string[];
	namePatterns: RegExp[];
}

export const HIGH_RISK_WARNING = "This app can run commands, change settings or expose credentials. Confirm the exact action, not just the app.";

export const APP_CATEGORIES: AppCategory[] = [
	{
		id: "browser",
		label: "Browser",
		// PLAN D2: browsers default to full.
		tier: "full",
		bundleIds: [
			"com.apple.Safari",
			"com.google.Chrome",
			"org.chromium.Chromium",
			"company.thebrowser.Browser",
			"company.thebrowser.dia",
			"com.brave.Browser",
			"com.microsoft.edgemac",
			"com.vivaldi.Vivaldi",
			"net.imput.helium",
			"org.mozilla.firefox",
		],
		namePatterns: [/safari|chrome|chromium|brave|edge|vivaldi|firefox|helium|arc\b/i],
	},
	{
		id: "terminal",
		label: "Terminal",
		tier: "click",
		warning: HIGH_RISK_WARNING,
		bundleIds: ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "net.kovidgoyal.kitty", "org.alacritty", "com.github.wez.wezterm", "co.zeit.hyper"],
		namePatterns: [/terminal|iterm|warp|kitty|alacritty|wezterm|hyper/i],
	},
	{
		id: "ide",
		label: "IDE / editor",
		tier: "click",
		warning: HIGH_RISK_WARNING,
		bundleIds: [
			"com.jetbrains.intellij",
			"com.jetbrains.intellij.ce",
			"com.jetbrains.WebStorm",
			"com.jetbrains.pycharm",
			"com.jetbrains.CLion",
			"com.jetbrains.goland",
			"com.jetbrains.rider",
			"com.jetbrains.PhpStorm",
			"com.jetbrains.AppCode",
			"com.microsoft.VSCode",
			"com.microsoft.VSCodeInsiders",
			"com.apple.dt.Xcode",
			"com.sublimetext.4",
			"com.todesktop.230313mzl4w4u92",
			"dev.zed.Zed",
		],
		namePatterns: [/intellij|webstorm|pycharm|clion|goland|rider|phpstorm|xcode|visual studio code|^code\b|sublime|zed\b/i],
	},
	{
		id: "finder",
		label: "Finder",
		tier: "click",
		warning: HIGH_RISK_WARNING,
		bundleIds: ["com.apple.finder"],
		namePatterns: [/^finder$/i],
	},
	{
		id: "system-settings",
		label: "System Settings",
		tier: "click",
		warning: HIGH_RISK_WARNING,
		bundleIds: ["com.apple.systempreferences", "com.apple.Settings", "com.apple.systemsettings", "com.apple.ActivityMonitor", "com.apple.DiskUtility"],
		namePatterns: [/system settings|system preferences|activity monitor|disk utility|系统设置|活动监视器/i],
	},
	{
		id: "password-manager",
		label: "Password manager",
		tier: "click",
		warning: `${HIGH_RISK_WARNING} Secure fields are never typed into.`,
		bundleIds: ["com.1password.1password", "com.bitwarden.desktop", "org.keepassxc.keepassxc", "com.lastpass.LastPass", "com.dashlane.dashlane", "com.apple.keychainaccess", "in.sinew.Enpass-Desktop"],
		namePatterns: [/1password|bitwarden|keepass|lastpass|dashlane|keychain access|enpass/i],
	},
	{
		id: "trading-banking",
		label: "Trading / banking",
		// PLAN §7: transaction and banking apps are observation-only by default.
		tier: "view",
		bundleIds: ["com.apple.Stocks", "com.robinhood.release", "com.interactivebrokers.ibkr", "com.binance.BinanceDesktop", "com.coinbase.consumer", "com.schwab.thinkorswim", "com.fidelity.investor"],
		namePatterns: [/stocks?|robinhood|binance|coinbase|schwab|fidelity|interactive brokers|银行|证券|券商|交易/i],
	},
];

const OTHER_CATEGORY: AppCategory = { id: "other", label: "Other", tier: "full", bundleIds: [], namePatterns: [] };

export interface AppIdentity {
	appName?: string;
	bundleId?: string;
}

export function classifyApp(app: AppIdentity | undefined): AppCategory {
	if (!app) return OTHER_CATEGORY;
	const bundleId = app.bundleId?.trim();
	const name = app.appName?.trim();
	for (const category of APP_CATEGORIES) {
		if (bundleId && category.bundleIds.some((known) => known.toLowerCase() === bundleId.toLowerCase())) return category;
	}
	for (const category of APP_CATEGORIES) {
		if (name && category.namePatterns.some((pattern) => pattern.test(name))) return category;
	}
	return OTHER_CATEGORY;
}

/** Stable identity for policy files and session approval caching. */
export function appPolicyKey(app: AppIdentity | undefined, fallback: string): string {
	return app?.bundleId?.trim() || app?.appName?.trim() || fallback;
}

export function categoryWarnings(app: AppIdentity | undefined): string | undefined {
	return classifyApp(app).warning;
}

export function catalogueTierOf(app: AppIdentity | undefined): AppTier {
	return classifyApp(app).tier;
}
