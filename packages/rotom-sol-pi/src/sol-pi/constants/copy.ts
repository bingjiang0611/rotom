export const OFFLOAD_COPY = {
	deferred: (amount: string) => `compaction deferred, ~${amount}`,
	offloadedTokens: "context tokens offloaded",
	dependency: "compactionOffload requires observationPack: true",
};
