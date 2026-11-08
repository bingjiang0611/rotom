import { BrowserRelayClientV1, BrowserArtifactStoreV1 } from "./browser-relay.ts";
export interface BrowserCommandDependenciesV1 {
	platform: NodeJS.Platform;
	runInstaller(operation: "install" | "status", signal: AbortSignal, browser?: string): Promise<unknown>;
	probeRelay(signal: AbortSignal): Promise<void>;
}
export interface BrowserRelayExtensionDependenciesV1 {
	connectRelay(input: {
		sessionId: string;
	}): Promise<Pick<BrowserRelayClientV1, "request" | "close" | "closed">>;
	openArtifactStore(): Promise<BrowserArtifactStoreV1>;
	commands?: Partial<BrowserCommandDependenciesV1>;
}
export const DEFAULT_DEPENDENCIES: BrowserRelayExtensionDependenciesV1 = {
	connectRelay: (input) => BrowserRelayClientV1.connect(input),
	openArtifactStore: () => BrowserArtifactStoreV1.open(),
};
