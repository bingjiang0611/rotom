export const OFFLOAD_COPY = {
	deferred: (tokens: number) => `压缩推迟、腾出约 ${tokens} tokens`,
	dependency: "compactionOffload requires observationPack: true",
};
