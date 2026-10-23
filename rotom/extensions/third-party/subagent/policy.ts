import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PRODUCT_SUBAGENT_ALLOWED_COMMANDS = [
	"subagent-cost",
	"subagents-doctor",
	"subagents-guide",
	"subagents-detach",
	"subagents-stop",
	"subagents-models",
] as const;

export function productSubagentCommandAllowed(command: string): boolean {
	return (PRODUCT_SUBAGENT_ALLOWED_COMMANDS as readonly string[]).includes(command);
}

export function productSubagentShortcutAllowed(shortcut: string): boolean {
	return shortcut !== "ctrl+alt+f";
}

/** Product composition only: commands/shortcuts and a host publication fence.
 * Schema, action admission and evidence projection belong to the native component.
 * This extra host fence rejects late publication while product session shutdown drains.
 * One irreversible lease per Pi factory instance.
 * This fences publication, not package-internal disk writes or child execution.
 */
export function subagentPolicyApi(pi: ExtensionAPI): ExtensionAPI {
	let retired = false;
	const assertLive = () => {
		if (retired) throw new Error("Subagent runtime retired; publication rejected, execution remains unknown. Inspect the original run; do not replay writes.");
	};
	// Register before package handlers; reject publication even while shutdown awaits I/O.
	pi.on("session_shutdown", () => { retired = true; });
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "sendMessage" || property === "sendUserMessage" || property === "appendEntry") return (...args: any[]) => {
				// Synchronous throw is required: the notifier treats any return as accepted.
				assertLive();
				return (target[property] as Function).apply(target, args);
			};
			if (property === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
				const execute = definition.execute.bind(definition);
				return target.registerTool({
					...definition,
					execute(...args: Parameters<typeof definition.execute>) {
						assertLive();
						const forwarded = [...args] as Parameters<typeof definition.execute>;
						const update = args[3];
						if (update) forwarded[3] = (result) => { assertLive(); update(result); };
						return Promise.resolve(execute(...forwarded)).then((result) => {
							assertLive();
							return result;
						});
					},
				});
			};
			if (property === "registerShortcut") return (shortcut: string, options: any) => {
				if (productSubagentShortcutAllowed(shortcut)) return target.registerShortcut(shortcut as any, options);
			};
			if (property === "registerCommand") return (name: string, command: any) => {
				if (!productSubagentCommandAllowed(name)) return;
				if (name === "subagents-stop") return target.registerCommand(name, {
					...command,
					handler(args: string, ctx: any) {
						if (!args.trim()) {
							ctx.ui.notify("/subagents-stop requires an explicit current-session run id; the scheduled-run selector is outside the dev-agent product boundary.", "warning");
							return;
						}
						return command.handler(args, ctx);
					},
				});
				return target.registerCommand(name, command);
			};
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
