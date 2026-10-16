export const VERIFIED_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const DISTRIBUTION_PI_VERSION = "1.3.0-rotom.2";
export const DISTRIBUTION_PI_BUILD_SHA256 = "cd2a60d09a177fa7f9707c425f60eaabbad40258045a1863860136a582791c30";
export const MINIMUM_NODE_VERSION = "24.0.0";

export const VERIFIED_THIRD_PARTY_PACKAGES = {
	"@injaneity/pi-computer-use": { version: "0.5.1-rotom.0", integrity: "sha512-CNmDZatjUImvODkmVUZPMTx/exzojHdDNZGXSqk9yqpAtR54lnaUULbPvBtrqunhZnee+mGJwQW2wVkLVTEDtw==", archive: "vendor/injaneity-pi-computer-use-0.5.1-rotom.0.tgz" },
	"@juicesharp/rpiv-ask-user-question": { version: "2.6.2", integrity: "sha512-DS9yZHcaPr+/nf0x2CCfiXBod/1aWjGyakGM3lZAObuGDhYI0nFRE5gxTcCOfQug6JtJXjt1GlzyX8Pljefdzg==" },
	"pi-subagents": { version: "0.52.1-rotom.7", integrity: "sha512-6hbdcuDAqFSsYxlGzVptP1vbQc+x6Zxu4VAtSQVke6ZZWn+T+MWGvaLV06qATmCWo2bVfj0CNjJb8egQj96FPg==", archive: "vendor/pi-subagents-0.52.1-rotom.7.tgz" },
	"@narumitw/pi-goal": { version: "0.54.4-rotom.8", integrity: "sha512-nEQhj4obyLpYRUUpqZF9co8UeX7Jc1iPKrI0D3hSMW9cEXDrIzv+ZnrhGWqwyWWk4GB7cZ7NzO5LAjC5uNTI8g==", archive: "vendor/narumitw-pi-goal-0.54.4-rotom.8.tgz" },
	"pi-context-view": { version: "0.7.1", integrity: "sha512-74bg+Tb5SOVdjeUSW70I/yieDtAKcNeEETPj5zU3UFWlYnE3NCjGgA/fLCi6vsO9vmwbRcFmCINJBaoksxH1aw==" },
	"sol-pi": { version: "0.1.0-rotom.2", integrity: "sha512-9SOaxYtxnfbnU+IByPpz8dmk95eDsGs4dvi1sq9i2g3VrGxIok0sGatlhPLhiOUgETWZyRBtRHULCm+yZiOu2g==", archive: "vendor/sol-pi-0.1.0-rotom.2.tgz" },
};

export const RESOURCE_DESCRIPTORS_V1 = [
	{ id: "observability", kind: "extension", path: "extensions/observability", requiredFiles: ["index.ts", "dashboard.mjs"] },
	{ id: "browser", kind: "extension", path: "extensions/browser", loadPath: "extensions/browser/index.ts", requiredFiles: ["index.ts", "browser-relay.ts", "native-host.mjs", "install-chrome-relay.mjs", "chrome-extension/manifest.json", "chrome-extension/service-worker.js", "chrome-extension/operation-chrome.js", "chrome-extension/coordinate-click.js", "chrome-extension/full-read.js", "chrome-extension/interaction-scroll-target.js", "chrome-extension/relay-deadline.js", "chrome-extension/rendered-text.js", "chrome-extension/scoped-ax-ref.js", "chrome-extension/shared-tab-group.js"] },
	{ id: "coding-policy", kind: "extension", path: "extensions/coding-policy", loadPath: "extensions/coding-policy/index.ts", requiredFiles: ["index.ts", "repair-hints.ts", "pi-runtime-drift.ts"] },
	{ id: "third-party", kind: "extension", path: "extensions/third-party", requiredFiles: ["index.ts", "computer-use/recovery.ts", "deferred-tools/register.ts", "subagent/policy.ts", "sol-pi.ts", "package.json", "package-lock.json", "vendor/pi-subagents-0.52.1-rotom.7.tgz", "vendor/narumitw-pi-goal-0.54.4-rotom.8.tgz", "vendor/injaneity-pi-computer-use-0.5.1-rotom.0.tgz", "vendor/sol-pi-0.1.0-rotom.2.tgz", "node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts", "node_modules/@juicesharp/rpiv-ask-user-question/index.ts", "node_modules/pi-subagents/index.ts", "node_modules/@narumitw/pi-goal/src/index.ts", "node_modules/pi-context-view/src/index.ts", "node_modules/sol-pi/src/sol-pi/index.ts"] },
	{ id: "qoder", kind: "extension", path: "extensions/qoder", loadPath: "extensions/qoder/index.ts", requiredFiles: ["index.ts", "auth.mjs", "catalog.mjs", "catalog-auth.mjs", "credits.mjs", "legacy.mjs", "messages.mjs", "oauth.mjs", "refresh-guard.mjs", "provider.mjs", "session-policy.mjs", "transport.mjs", "translate.mjs"] },
	{ id: "pi-subagents", kind: "skill", path: "skills/pi-subagents", requiredFiles: ["SKILL.md"] },
];
