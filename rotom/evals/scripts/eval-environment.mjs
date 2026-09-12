const PROXY_VARIABLES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"];

export function prepareEvalChildEnvironment(environment) {
	const result = { ...environment };
	const proxyConfigured = PROXY_VARIABLES.some((name) => result[name]?.trim());
	if (proxyConfigured && result.NODE_USE_ENV_PROXY === undefined) result.NODE_USE_ENV_PROXY = "1";
	return { environment: result, nodeEnvProxy: result.NODE_USE_ENV_PROXY === "1" };
}
