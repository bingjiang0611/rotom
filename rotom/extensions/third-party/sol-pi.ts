import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, findConfigPath, loadSolPiConfig, type SolPiConfig } from "./node_modules/sol-pi/src/sol-pi/config.ts";

/**
 * rotom's default when the user has no SoL-Pi config file. It replaces
 * SoL-Pi's all-off default with the features the maintainer runs daily.
 * Online Context Compact stays off. Any existing config file wins unchanged.
 */
export const ROTOM_SOL_PI_DEFAULT_CONFIG: SolPiConfig = Object.freeze({
	...DEFAULT_CONFIG,
	actionFusion: true,
	observationPack: true,
	evidencePreservingReducer: true,
});

export function loadRotomSolPiConfig(ctx: ExtensionContext, agentDir = getAgentDir()): SolPiConfig {
	const allowProjectConfig = ctx.isProjectTrusted();
	if (findConfigPath(ctx.cwd, agentDir, allowProjectConfig) === undefined) return ROTOM_SOL_PI_DEFAULT_CONFIG;
	return loadSolPiConfig(ctx.cwd, agentDir, allowProjectConfig);
}
