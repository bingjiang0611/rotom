export const VERIFIED_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const DISTRIBUTION_PI_VERSION = "0.85.1-rotom.2";
export const DISTRIBUTION_PI_BUILD_SHA256 = "b447d80470b3fad9421b102f70279164e62af4b7d8ab70c80e71061c1da65fb2";
export const MINIMUM_NODE_VERSION = "24.0.0";
export const VERIFIED_HERDR_PI_INTEGRATION_VERSION = "8";

export const VERIFIED_THIRD_PARTY_PACKAGES = {
	"@injaneity/pi-computer-use": { version: "0.5.1-rotom.0", integrity: "sha512-CNmDZatjUImvODkmVUZPMTx/exzojHdDNZGXSqk9yqpAtR54lnaUULbPvBtrqunhZnee+mGJwQW2wVkLVTEDtw==", archive: "vendor/injaneity-pi-computer-use-0.5.1-rotom.0.tgz" },
	"@juicesharp/rpiv-ask-user-question": { version: "2.6.2", integrity: "sha512-DS9yZHcaPr+/nf0x2CCfiXBod/1aWjGyakGM3lZAObuGDhYI0nFRE5gxTcCOfQug6JtJXjt1GlzyX8Pljefdzg==" },
	"pi-subagents": { version: "0.52.1-rotom.3", integrity: "sha512-iBYI5r33HveCRqjKflz0s9cHZ4m7OEc+gV6mg/dFTL83edW/2nyW1ZGANqC5QmhEb7aalwVzBNVzi4B054UooQ==", archive: "vendor/pi-subagents-0.52.1-rotom.3.tgz" },
	"@narumitw/pi-goal": { version: "0.54.4-rotom.5", integrity: "sha512-ouFy7ygrnkaGpD/OBQCTKlTISor2KGB6AMaUg7QrHCqL2ubXikUv7iD9Q34ZWCuBFTtsPEs8SCa4YbBGjgcm2g==", archive: "vendor/narumitw-pi-goal-0.54.4-rotom.5.tgz" },
};

export const RESOURCE_DESCRIPTORS_V1 = [
	{ id: "observability", kind: "extension", path: "extensions/observability", requiredFiles: ["index.ts", "dashboard.mjs"] },
	{ id: "browser", kind: "extension", path: "extensions/browser", loadPath: "extensions/browser/index.ts", requiredFiles: ["index.ts", "browser-relay.ts", "native-host.mjs", "install-chrome-relay.mjs", "chrome-extension/manifest.json", "chrome-extension/service-worker.js", "chrome-extension/operation-chrome.js", "chrome-extension/coordinate-click.js", "chrome-extension/full-read.js", "chrome-extension/interaction-scroll-target.js", "chrome-extension/relay-deadline.js", "chrome-extension/rendered-text.js", "chrome-extension/scoped-ax-ref.js", "chrome-extension/shared-tab-group.js"] },
	{ id: "coding-policy", kind: "extension", path: "extensions/coding-policy", loadPath: "extensions/coding-policy/index.ts", requiredFiles: ["index.ts", "repair-hints.ts", "pi-runtime-drift.ts"] },
	{ id: "third-party", kind: "extension", path: "extensions/third-party", requiredFiles: ["index.ts", "computer-use/recovery.ts", "deferred-tools/register.ts", "subagent/policy.ts", "package.json", "package-lock.json", "vendor/pi-subagents-0.52.1-rotom.3.tgz", "vendor/narumitw-pi-goal-0.54.4-rotom.5.tgz", "vendor/injaneity-pi-computer-use-0.5.1-rotom.0.tgz", "node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts", "node_modules/@juicesharp/rpiv-ask-user-question/index.ts", "node_modules/pi-subagents/index.ts", "node_modules/@narumitw/pi-goal/src/index.ts"] },
	{ id: "qoder", kind: "extension", path: "extensions/qoder", loadPath: "extensions/qoder/index.ts", requiredFiles: ["index.ts", "auth.mjs", "catalog.mjs", "catalog-auth.mjs", "credits.mjs", "legacy.mjs", "messages.mjs", "oauth.mjs", "refresh-guard.mjs", "provider.mjs", "session-policy.mjs", "transport.mjs", "translate.mjs"] },
	{ id: "pi-subagents", kind: "skill", path: "skills/pi-subagents", requiredFiles: ["SKILL.md"] },
];
