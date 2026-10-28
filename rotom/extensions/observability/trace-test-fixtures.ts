import { createObservabilityExtensionV1 } from "./index.ts";
import { qoderDiagnosticAttributes, PROVIDER_METADATA_EVENT } from "../qoder/diagnostics.mjs";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

export function extensionHarness(toolApi: Record<string, unknown> = {}) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const commands = new Map<string, any>();
	const pi = {
		...toolApi,
		events: {
			emit(channel: string, data: unknown) { for (const handler of eventHandlers.get(channel) ?? []) handler(data); },
			on(channel: string, handler: (data: unknown) => void) {
				eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
				return () => eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler));
			},
		},
		on(event: string, handler: Handler) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
	} as any;
	createObservabilityExtensionV1()(pi);
	return {
		handlers,
		commands,
		emitDiagnostic(value: unknown) { pi.events.emit(PROVIDER_METADATA_EVENT, { provider: "qoder", attributes: qoderDiagnosticAttributes(value) }); },
		emitMetadata(value: unknown, provider = "qoder") { pi.events.emit(PROVIDER_METADATA_EVENT, { provider, attributes: value }); },
		async emit(event: string, value: any, ctx: any) {
			for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
		},
	};
}

export function assistantMessage(stopReason = "toolUse") {
	return {
		role: "assistant",
		provider: "test-provider",
		model: "test-model",
		api: "test-api",
		stopReason,
		usage: {
			input: 120,
			output: 30,
			cacheRead: 40,
			cacheWrite: 5,
			reasoning: 7,
			totalTokens: 195,
			cost: { total: 0.0123 },
		},
	};
}
