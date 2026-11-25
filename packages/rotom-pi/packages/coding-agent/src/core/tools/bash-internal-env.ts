// These configure the agent host and deliberately spawned child Pi processes,
// not arbitrary user commands. Sanitize at dispatch, including spawn-hook envs.
const INTERNAL_AGENT_ENV = [
	"PI_SUBAGENTS_EXECUTION_SCOPE",
	"PI_SUBAGENTS_TEMP_ROOT",
	"PI_SUBAGENT_MAX_SPAWNS_PER_SESSION",
	"ROTOM_VERIFIED_PI_EXECUTABLE",
	"ROTOM_VERIFIED_PI_VERSION",
	"ROTOM_DEFERRED_DEFAULT_SURFACE",
	"ROTOM_SUBAGENT_QODER_EXTENSION",
	"ROTOM_PRODUCT_VERSION",
];

export function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result = { ...env };
	for (const name of INTERNAL_AGENT_ENV) delete result[name];
	return result;
}
