import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Relay-first fallback is product composition: the standalone Computer Use
// component does not know whether Rotom's Chrome Relay exists.
export function computerUseRecoveryApi(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
				if (definition.name === "launch_browser") return target.registerTool({
					...definition,
					description: "Fallback only after Chrome Relay is unavailable: launch an isolated CDP browser without existing Chrome login state.",
					promptSnippet: "Fallback browser launch after Relay unavailability; does not inherit Chrome login state.",
					promptGuidelines: [...(definition.promptGuidelines ?? []),
						"Use browser_inspect/browser_interact first when available. Call launch_browser only after an explicit pre-dispatch Relay-unavailable error permits fallback; tell the user the isolated browser has no existing Chrome cookies/login. Login pages, empty results, stale refs, timeout, unknown, cancellation or protocol/permission errors are not fallback reasons. Never replay writes across browsers or retry an unknown launch. After fallback use its fresh CDP stateId with observe_ui/navigate_browser/evaluate_browser/act_ui, not Relay refs."],
				});
				return target.registerTool(definition);
			};
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
