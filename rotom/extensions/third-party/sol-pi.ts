import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, findConfigPath, loadSolPiConfig, type SolPiConfig } from "./node_modules/sol-pi/src/sol-pi/config.ts";

/**
 * rotom's default when the user has no SoL-Pi config file. It replaces
 * SoL-Pi's all-off default with the features the maintainer runs daily.
 * Online Context Compact and Compaction Offload stay off. An existing file
 * replaces these defaults; the explicit offload environment override is last.
 */
export const ROTOM_SOL_PI_DEFAULT_CONFIG: SolPiConfig = Object.freeze({
	...DEFAULT_CONFIG,
	actionFusion: true,
	observationPack: true,
	evidencePreservingReducer: true,
	compactionOffload: false,
});

const COPY = {
	requiresObservationPack: "[rotom] ROTOM_COMPACTION_OFFLOAD=1 requires Observation Pack; compaction offload remains disabled",
	invalidOverride: "[rotom] ROTOM_COMPACTION_OFFLOAD must be 1 or 0; ignoring invalid value",
};

export function loadRotomSolPiConfig(ctx: ExtensionContext, agentDir = getAgentDir()): SolPiConfig {
	const allowProjectConfig = ctx.isProjectTrusted();
	const config = findConfigPath(ctx.cwd, agentDir, allowProjectConfig) === undefined
		? ROTOM_SOL_PI_DEFAULT_CONFIG
		: loadSolPiConfig(ctx.cwd, agentDir, allowProjectConfig);
	const override = process.env.ROTOM_COMPACTION_OFFLOAD;
	if (override === undefined || override === "") return config;
	if (override === "0") return Object.freeze({ ...config, compactionOffload: false });
	if (override === "1") {
		if (!config.observationPack) console.error(COPY.requiresObservationPack);
		return Object.freeze({ ...config, compactionOffload: config.observationPack });
	}
	console.error(COPY.invalidOverride);
	return config;
}
