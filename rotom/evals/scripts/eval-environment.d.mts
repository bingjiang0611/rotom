export function prepareEvalChildEnvironment(environment: NodeJS.ProcessEnv): {
	environment: NodeJS.ProcessEnv;
	nodeEnvProxy: boolean;
};
