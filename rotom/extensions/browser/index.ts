import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DEPENDENCIES, type BrowserRelayExtensionDependenciesV1 } from "./browser-dependencies.ts";
import { createBrowserRuntimeV1 } from "./browser-runtime.ts";
import { registerBrowserInspectV1 } from "./inspect-tool.ts";
import { registerBrowserInteractV1 } from "./interact-tool.ts";
import { registerBrowserDevtoolsV1 } from "./devtools-tool.ts";
import { registerBrowserCommandV1 } from "./browser-command.ts";
export type { BrowserCommandDependenciesV1, BrowserRelayExtensionDependenciesV1 } from "./browser-dependencies.ts";
export function createBrowserRelayExtensionV1(dependencies: BrowserRelayExtensionDependenciesV1 = DEFAULT_DEPENDENCIES) {
	return function browserRelayExtension(pi: ExtensionAPI): void {
		const runtime = createBrowserRuntimeV1(pi, dependencies);
		registerBrowserInspectV1(pi, runtime);
		registerBrowserInteractV1(pi, runtime);
		registerBrowserDevtoolsV1(pi, runtime);
		registerBrowserCommandV1(pi, runtime, dependencies.commands);
	};
}
export default createBrowserRelayExtensionV1();
