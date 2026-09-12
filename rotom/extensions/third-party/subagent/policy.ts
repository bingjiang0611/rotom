import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PRODUCT_SUBAGENT_ALLOWED_ACTIONS = [
	"list",
	"get",
	"models",
	"children.list",
	"guide",
	"status",
	"interrupt",
	"resume",
	"steer",
	"stop",
	"dismiss",
	"doctor",
	"watchdog.status",
	"watchdog.check",
	"watchdog.recommend-model",
] as const;

export const PRODUCT_SUBAGENT_ALLOWED_COMMANDS = [
	"subagent-cost",
	"subagents-doctor",
	"subagents-guide",
	"subagents-detach",
	"subagents-stop",
	"subagents-models",
] as const;

export const PRODUCT_SUBAGENT_BLOCKED_FIELDS = [
	"name",
	"handoffPath",
	"additional",
	"scope",
	"target",
	"focus",
	"at",
	"every",
	"on",
	"timezone",
	"overlap",
	"catchUp",
	"missionId",
	"mission",
	"missionUpdate",
	"missionStatus",
	"missionScope",
	"runMode",
	"runStatus",
	"summary",
	"config",
] as const;

export const PRODUCT_SUBAGENT_POLICY_GUIDELINE =
	"Product policy overrides broader package documentation: omit action for execution; only the model-visible actions in the schema are available. Agent configuration, missions, refine, schedules, project/inspector management, worktree discard, watchdog configuration, and spawn-budget grants are disabled. Actionless execution is forced ephemeral and cannot create an automatic mission. Omit mission entirely; an explicit mission:false is accepted and ignored, while any truthy mission or other mission field is rejected. For one implementation or validation lane, steer its live child or resume its latest run with a compact handoff; do not fork duplicate full-history workers for that lane. Direct steer always disables automatic steeringRecovery; acknowledgement timeout is not writer termination or permission to replace it.";

export const PRODUCT_HANDOFF_GUIDELINE =
	"For handoffs and summaries, keep constraints, unknowns and the next authorized action. Summaries are not evidence; never upgrade unknown to success. Cite readable evidence and its command/result/scope; revalidate missing, conflicting or stale sources against the current revision and relevant dirty files.";

const allowedActionSet = new Set<string>(PRODUCT_SUBAGENT_ALLOWED_ACTIONS);
const blockedFieldSet = new Set<string>(PRODUCT_SUBAGENT_BLOCKED_FIELDS);

export function constrainSubagentParameters<T>(parameters: T): T {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return parameters;
	const schema = parameters as Record<string, unknown>;
	const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
		? { ...(schema.properties as Record<string, unknown>) }
		: undefined;
	if (!properties) return parameters;
	for (const field of blockedFieldSet) delete properties[field];
	const action = properties.action && typeof properties.action === "object" && !Array.isArray(properties.action)
		? properties.action as Record<string, unknown>
		: {};
	properties.action = { ...action, enum: [...PRODUCT_SUBAGENT_ALLOWED_ACTIONS] };
	return { ...schema, properties } as T;
}

export function prepareProductSubagentArguments(params: Record<string, unknown>): Record<string, unknown> {
	const action = typeof params.action === "string" ? params.action.trim() : undefined;
	if (action !== undefined && !allowedActionSet.has(action)) {
		throw new Error(`Subagent action '${action}' is outside the dev-agent product boundary.`);
	}
	// `mission:false` is exactly the value this product forces, so an explicit false is a compliant
	// no-op instead of a failed call; only a truthy mission escapes the product boundary.
	const normalized = { ...params } as Record<string, unknown>;
	if (Object.hasOwn(normalized, "mission")) {
		if (normalized.mission === false) delete normalized.mission;
		else throw new Error("Subagent field 'mission' is outside the dev-agent product boundary; omit it or pass mission:false.");
	}
	for (const field of blockedFieldSet) {
		if (Object.hasOwn(normalized, field)) {
			throw new Error(`Subagent field '${field}' is outside the dev-agent product boundary.`);
		}
	}
	if (action !== undefined) return { ...normalized, action, ...(action === "steer" ? { steeringRecovery: false } : {}) };
	return { ...normalized, mission: false };
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A projection, not another lifecycle authority. Never parse prose or repair disk state. */
export function subagentEvidenceResult<T>(toolName: string, params: unknown, result: T): T {
	if (toolName !== "subagent" && toolName !== "subagent_wait") return result;
	const value = resultRecord(result);
	const details = resultRecord(value?.details);
	if (!value || !details || !Array.isArray(value.content)) return result;
	const request = resultRecord(params);
	const launchReceipt = toolName === "subagent" && request?.action === undefined && value.isError !== true
		&& typeof details.asyncId === "string" && Array.isArray(details.results) && details.results.length === 0;
	const stopReceipt = toolName === "subagent" && request?.action === "stop" && value.isError !== true;
	const lifecycle = resultRecord(details.lifecycleStatus);
	const terminal = resultRecord(lifecycle?.processTerminal);
	const terminalState = typeof terminal?.state === "string" && ["pending", "observed", "unknown", "not-started"].includes(terminal.state) ? terminal.state : undefined;
	const relevant = launchReceipt || stopReceipt || toolName === "subagent_wait" || details.workflow !== undefined || lifecycle !== undefined;
	if (!relevant) return result;
	const evidence = launchReceipt
		? "Subagent evidence: launch receipt only; child completion has not been established."
		: stopReceipt
			? "Subagent evidence: a stop response is not proof of cancellation convergence or writer termination."
			: "Subagent evidence: the returned task/workflow state is not proof that every child or external effect has finished.";
	const process = terminalState ? ` Reported process-terminal=${terminalState}; this is scoped process evidence, not whole-process-tree or remote-effect closure.` : " Process termination is not established by this result.";
	const text = `${evidence}${process} Inspect the original run and verify its output; unknown does not authorize replay or a replacement writer.`;
	return { ...value, content: [{ type: "text", text }, ...value.content] } as T;
}

export function productSubagentCommandAllowed(command: string): boolean {
	return (PRODUCT_SUBAGENT_ALLOWED_COMMANDS as readonly string[]).includes(command);
}

export function productSubagentShortcutAllowed(shortcut: string): boolean {
	return shortcut !== "ctrl+alt+f";
}

/** One product proxy and one irreversible lease per Pi factory instance.
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
				const isSubagent = definition.name === "subagent";
				const execute = definition.execute.bind(definition);
				return target.registerTool({
					...definition,
					...(isSubagent ? {
						description: `${definition.description}\n\n${PRODUCT_SUBAGENT_POLICY_GUIDELINE}`,
						parameters: constrainSubagentParameters(definition.parameters),
						promptGuidelines: [...(definition.promptGuidelines ?? []), PRODUCT_SUBAGENT_POLICY_GUIDELINE, PRODUCT_HANDOFF_GUIDELINE],
					} : {}),
					execute(...args: Parameters<typeof definition.execute>) {
						assertLive();
						const forwarded = [...args] as Parameters<typeof definition.execute>;
						if (isSubagent) forwarded[1] = prepareProductSubagentArguments(args[1] as Record<string, unknown>);
						const update = args[3];
						if (update) forwarded[3] = (result) => { assertLive(); update(result); };
						return Promise.resolve(execute(...forwarded)).then((result) => {
							assertLive();
							return subagentEvidenceResult(definition.name, forwarded[1], result);
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
