export const VERIFIED_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const DISTRIBUTION_PI_VERSION = "1.4.0-rotom.2";
export const DISTRIBUTION_PI_BUILD_SHA256 = "66ae5b8c9b57761e7f14528d7ddc92fa6cb4705e051864124d2a66b12335b6a7";
export const MINIMUM_NODE_VERSION = "24.0.0";

export const VERIFIED_THIRD_PARTY_PACKAGES = {
	"@injaneity/pi-computer-use": { version: "0.5.1-rotom.2", integrity: "sha512-dcJn+H5u9jwvrrDPeAC38NsyaZzJ17cNxqxFtaaW41DzHh+pxmh0p6r497L5DFNp+0+iKkmPD9Kpcc7wFo9QfQ==", archive: "vendor/injaneity-pi-computer-use-0.5.1-rotom.2.tgz" },
	"@juicesharp/rpiv-ask-user-question": { version: "2.6.2", integrity: "sha512-DS9yZHcaPr+/nf0x2CCfiXBod/1aWjGyakGM3lZAObuGDhYI0nFRE5gxTcCOfQug6JtJXjt1GlzyX8Pljefdzg==" },
	"pi-subagents": { version: "0.52.1-rotom.11", integrity: "sha512-QsfO3DJV9ghMfVQXLBHjaT8sOWORa56BmUA5B1w32SZM8ycvA8KfOResQJtSmm6YNxCo6mIdw0vmd5DJQo7ptA==", archive: "vendor/pi-subagents-0.52.1-rotom.11.tgz" },
	"@narumitw/pi-goal": { version: "0.54.4-rotom.9", integrity: "sha512-mqoDynv2Pq6rjNCFfWl0Moylb01u+AC/f0mGp1Taxa6iMrPVUc3Xs64u/x3X4gDShnUjFGTnThtmhr+VGd27Fg==", archive: "vendor/narumitw-pi-goal-0.54.4-rotom.9.tgz" },
	"pi-context-view": { version: "0.7.1", integrity: "sha512-74bg+Tb5SOVdjeUSW70I/yieDtAKcNeEETPj5zU3UFWlYnE3NCjGgA/fLCi6vsO9vmwbRcFmCINJBaoksxH1aw==" },
	"sol-pi": { version: "0.1.0-rotom.3", integrity: "sha512-0VdUzHtsICuHIp/Sp77Qem5snQH63PY/XbwxY8fLgweLlFM/uE65OnRhhHvQ9c0Wi0PWWUqGWMXlkqTkgqSntw==", archive: "vendor/sol-pi-0.1.0-rotom.3.tgz" },
};

export const RESOURCE_DESCRIPTORS_V1 = [
	{ id: "observability", kind: "extension", path: "extensions/observability", requiredFiles: ["index.ts", "dashboard.mjs", "dashboard-copy.mjs", "eval/judge.mjs", "eval/judge-prompt.mjs", "eval/judge-store.mjs", "eval/annotations.mjs", "eval/service.mjs", "eval/copy.mjs", "eval/ui.mjs", "eval/session-data.mjs", "eval/session-metrics.mjs", "eval/trace-assertions.mjs"] },
	{ id: "browser", kind: "extension", path: "extensions/browser", loadPath: "extensions/browser/index.ts", requiredFiles: ["index.ts", "browser-relay.ts", "native-host.mjs", "install-chrome-relay.mjs", "chrome-extension/manifest.json", "chrome-extension/service-worker.js", "chrome-extension/operation-chrome.js", "chrome-extension/coordinate-click.js", "chrome-extension/full-read.js", "chrome-extension/interaction-scroll-target.js", "chrome-extension/relay-deadline.js", "chrome-extension/rendered-text.js", "chrome-extension/scoped-ax-ref.js", "chrome-extension/shared-tab-group.js"] },
	{ id: "coding-policy", kind: "extension", path: "extensions/coding-policy", loadPath: "extensions/coding-policy/index.ts", requiredFiles: ["index.ts", "repair-hints.ts", "pi-runtime-drift.ts", "edit-error-code.mjs"] },
	{ id: "context-layers", kind: "extension", path: "extensions/context-layers", loadPath: "extensions/context-layers/index.ts", requiredFiles: ["index.ts", "blocks.ts", "recall.ts", "copy.ts"] },
	{ id: "third-party", kind: "extension", path: "extensions/third-party", requiredFiles: ["index.ts", "ask/schema.ts", "computer-use/recovery.ts", "deferred-tools/register.ts", "subagent/policy.ts", "sol-pi.ts", "package.json", "package-lock.json", "node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts", "node_modules/@juicesharp/rpiv-ask-user-question/index.ts", "node_modules/pi-subagents/index.ts", "node_modules/@narumitw/pi-goal/src/index.ts", "node_modules/pi-context-view/src/index.ts", "node_modules/sol-pi/src/sol-pi/index.ts"] },
	{ id: "qoder", kind: "extension", path: "extensions/qoder", loadPath: "extensions/qoder/index.ts", requiredFiles: ["index.ts", "auth.mjs", "catalog.mjs", "catalog-auth.mjs", "credits.mjs", "diagnostics.mjs", "legacy.mjs", "messages.mjs", "oauth.mjs", "refresh-guard.mjs", "provider.mjs", "session-policy.mjs", "transport.mjs", "translate.mjs"] },
	{ id: "pi-subagents", kind: "skill", path: "skills/pi-subagents", requiredFiles: ["SKILL.md"] },
];
