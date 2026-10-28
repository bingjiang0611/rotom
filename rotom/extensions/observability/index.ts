import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_METADATA_EVENT } from "./trace-schema.ts";
import { runtimeVersionAttributes } from "./model-metadata.ts";
import { toolSurfaceMetrics } from "./tool-metadata.ts";
import { LocalTraceWriterV1, localTracePathForSessionFile } from "./trace-writer.ts";
import { LocalTraceRecorderV1 } from "./trace-recorder.ts";

function enabledByEnvironment(value = process.env.ROTOM_OBSERVABILITY): boolean {
	return value === undefined || !/^(?:0|false|no)$/iu.test(value.trim());
}

export function createObservabilityExtensionV1() {
	return function observabilityExtension(pi: ExtensionAPI): void {
		let recorder: LocalTraceRecorderV1 | undefined;
		let writer: LocalTraceWriterV1 | undefined;
		let unavailableReason = "session-not-started";

		pi.registerCommand("trace", {
			description: "Show the current local metadata trace path and write status",
			async handler(_args, ctx) {
				await writer?.flush();
				const message = writer
					? `Local metadata trace: ${writer.path}\nrecords=${writer.recordsWritten} dropped=${writer.recordsDropped} healthy=${writer.healthy}`
					: `Local metadata trace unavailable: ${unavailableReason}`;
				ctx.ui.notify(message, writer?.healthy === false ? "warning" : "info");
			},
		});

		pi.events.on(PROVIDER_METADATA_EVENT, (metadata) => recorder?.providerMetadata(metadata));

		pi.on("session_start", async (event, ctx) => {
			if (recorder) await recorder.shutdown("reload");
			recorder = undefined;
			writer = undefined;
			if (!enabledByEnvironment()) { unavailableReason = "disabled-by-ROTOM_OBSERVABILITY"; return; }
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) { unavailableReason = "ephemeral-session"; return; }
			writer = new LocalTraceWriterV1(localTracePathForSessionFile(sessionFile));
			recorder = new LocalTraceRecorderV1(writer, ctx.sessionManager.getSessionId(), {
				"pi.session.start_reason": event.reason,
				"pi.session.mode": ctx.mode,
				...runtimeVersionAttributes(),
			});
			unavailableReason = "available";
		});
		pi.on("before_agent_start", (event, ctx) => recorder?.beforeAgentStart(event, ctx));
		pi.on("agent_start", (_event, ctx) => recorder?.agentStart(ctx));
		pi.on("turn_start", (event, ctx) => recorder?.turnStart(event, ctx));
		pi.on("before_provider_headers", (_event, ctx) => {
			if (recorder) recorder.providerStart(ctx, toolSurfaceMetrics(pi));
		});
		pi.on("after_provider_response", (event) => recorder?.providerResponse(event.status));
		pi.on("message_update", (event) => recorder?.messageUpdate(event));
		pi.on("message_end", (event, ctx) => recorder?.messageEnd(event.message, ctx));
		pi.on("tool_execution_start", (event, ctx) => recorder?.toolStart(event, ctx));
		pi.on("tool_execution_update", (event) => recorder?.toolUpdate(event));
		pi.on("tool_execution_end", (event) => recorder?.toolEnd(event));
		pi.on("turn_end", (event) => recorder?.turnEnd(event));
		pi.on("agent_end", (event) => recorder?.agentEnd(event));
		pi.on("agent_settled", () => recorder?.settled());
		pi.on("session_before_compact", (event) => recorder?.compactionStart(event));
		pi.on("session_compact", (event) => recorder?.compactionEnd(event, false));
		pi.on("session_compact_failed", (event) => recorder?.compactionEnd(event, true));
		pi.on("session_shutdown", async (event) => {
			await recorder?.shutdown(event.reason);
			recorder = undefined;
		});
	};
}

export default createObservabilityExtensionV1();
