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

export const PRODUCT_SUBAGENT_DESCRIPTION =
	"Delegate one task with agent/task; use workflowScript for multi-step or parallel work. Execution omits action; management uses only the listed actions. Work is ephemeral: agent configuration, missions, schedules, refine and project/inspector management are unavailable. Use status with id for diagnosis, view:'transcript' for a bounded output tail, or children.list for retained workflow children.";

export const PRODUCT_SUBAGENT_POLICY_GUIDELINE =
	"For delegation use async:true, context:'fresh' and an absolute cwd. Keep one writer per cwd; steer its live child or resume its latest run with a compact handoff instead of duplicating that lane. Do not sleep or poll status to wait; use subagent_wait at a dependency barrier when this turn must finish. Acknowledgement timeout is not writer termination or permission to replace it; steering never auto-recovers. Unknown work does not authorize replay.";

export const PRODUCT_SUBAGENT_SCOPED_GUIDELINE =
	"Owned scope admits one async Pi/external CLI task or an async workflow controller with independent async children or fresh single foreground Pi children. Agents require explicit tools and extensions; ambient discovery, fork/import, nested delegation, worktrees, host gates, verification/review execution and external jobs are not admitted. Explicit extensions are trusted local code, not a sandbox. Closure covers registered resources only, not escaped descendants or business effects. Resume is limited to the original async Pi run after closure and canonical lease checks; workflow/retained-child/external recovery is unavailable.";

export const PRODUCT_SUBAGENT_ACCEPTANCE_GUIDELINE =
	"For read-only reviewer/scout tasks, omit acceptance and use the inferred read-only contract. Explicit checked/verified adds command and no-staged-files requirements; evidence is additive, not a replacement. Workflow-level acceptance is inherited by children: do not impose writer gates on shell-less reviewers. Have a capable parent verify Git/build evidence separately. A supervisor message cannot waive a frozen acceptance contract; never invent evidence or silently lower an explicit gate.";

export const PRODUCT_HANDOFF_GUIDELINE =
	"For handoffs and summaries, keep constraints, unknowns and the next authorized action. Summaries are not evidence; never upgrade unknown to success. Cite readable evidence and its command/result/scope; revalidate missing, conflicting or stale sources against the current revision and relevant dirty files.";

const allowedActionSet = new Set<string>(PRODUCT_SUBAGENT_ALLOWED_ACTIONS);
const blockedFieldSet = new Set<string>(PRODUCT_SUBAGENT_BLOCKED_FIELDS);

export function constrainSubagentParameters<T>(parameters: T, scoped = process.env.PI_SUBAGENTS_EXECUTION_SCOPE === "owned-process-groups-v2"): T {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return parameters;
	const schema = parameters as Record<string, unknown>;
	const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
		? { ...(schema.properties as Record<string, unknown>) }
		: undefined;
	if (!properties) return parameters;
	for (const field of blockedFieldSet) delete properties[field];
	// These fields only configure retired watchdog actions or automatic recovery.
	// Execution still validates raw SDK inputs; this projection is not admission.
	delete properties.thinking;
	delete properties.steeringRecovery;
	const descriptions: Record<string, string> = {
		agent: "Configured agent for one task, or for get. Use list to inspect available roles.",
		id: "Original run id/prefix for status, interrupt, steer, stop, resume or dismiss.",
		runId: "Alias for id. Prefer id.",
		dir: "Original async run directory for status, stop, resume or steer. Never change storage base to retry unknown work.",
		message: "Follow-up for resume, or live guidance for steer.",
		cwd: "Absolute execution directory. Preserve the authorized repository and write scope.",
		topic: "Guide topic. Packaged legacy documentation does not extend the product's tool or scope contract.",
		workflowScript: "Trusted JavaScript statement body; omit top-level agent/task/action. Use top-level await runs.run(key,{agent,task}) for sequence, await runs.all([{key,agent,task},...]) for parallel work, and explicit return for results. Consume completed .output, never an unawaited promise. Await runs.steer(key,message,{mode?,index?,ackTimeoutMs?}) for a prior child key. runs.status, runs.ref/refs, emit and console are available. No nested async helpers, filesystem, shell, Pi tools, host globals or mission state.",
	};
	if (scoped) {
		for (const field of ["worktree", "isolation", "gate"]) delete properties[field];
		descriptions.context = "Fresh context only in owned scope. Supply required evidence in task; fork is unavailable.";
		descriptions.async = "Set true. Owned scope does not admit standalone foreground execution.";
		descriptions.chatProgress = "For async workflows use auto or off; live-card is unavailable.";
		descriptions.workflowScript += " Owned scope does not admit resume/worktree/gate child fields, nested delegation, verification/review execution or external jobs.";
	}
	for (const [field, description] of Object.entries(descriptions)) {
		if (properties[field]) properties[field] = { ...properties[field] as object, description };
	}
	if (scoped) {
		if (properties.context) properties.context = { ...properties.context as object, enum: ["fresh"] };
		if (properties.async) properties.async = { ...properties.async as object, enum: [true] };
		if (properties.chatProgress) properties.chatProgress = { ...properties.chatProgress as object, enum: ["auto", "off"] };
	}
	const action = properties.action && typeof properties.action === "object" && !Array.isArray(properties.action)
		? properties.action as Record<string, unknown>
		: {};
	properties.action = { ...action, enum: [...PRODUCT_SUBAGENT_ALLOWED_ACTIONS] };
	if (properties.acceptance && typeof properties.acceptance === "object") {
		properties.acceptance = { ...properties.acceptance as Record<string, unknown>, description: PRODUCT_SUBAGENT_ACCEPTANCE_GUIDELINE };
	}
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
	return {
		...value,
		...(launchReceipt || stopReceipt ? { details: { ...details, subagentPhase: launchReceipt ? "launch" : "stop-request" } } : {}),
		content: [{ type: "text", text }, ...value.content],
	} as T;
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
	// Launcher scope is fixed before extension construction; do not track mutable
	// environment changes as a second lifecycle authority.
	const scoped = process.env.PI_SUBAGENTS_EXECUTION_SCOPE === "owned-process-groups-v2";
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
						description: PRODUCT_SUBAGENT_DESCRIPTION,
						promptSnippet: "Delegate one task with agent/task and async:true; use workflowScript only for multi-step or parallel orchestration",
						parameters: constrainSubagentParameters(definition.parameters, scoped),
						promptGuidelines: [PRODUCT_SUBAGENT_POLICY_GUIDELINE, ...(scoped ? [PRODUCT_SUBAGENT_SCOPED_GUIDELINE] : []), PRODUCT_HANDOFF_GUIDELINE],
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
