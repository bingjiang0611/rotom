export const RECALL_COPY = {
	description: "Read a stored large tool result by observation id and byte offset. Continue only while eof=false; eof=true and next_offset=null mean stop paging.",
	continue: "continue with returned next_offset until eof=true (next_offset=null)",
	chunkHint: (eof: boolean) => eof ? "end of observation; stop paging" : "use next_offset to continue",
};

export const OFFLOAD_COPY = {
	deferred: (amount: string) => `compaction deferred, ~${amount}`,
	offloadedTokens: "context tokens offloaded",
	dependency: "compactionOffload requires observationPack: true",
};
