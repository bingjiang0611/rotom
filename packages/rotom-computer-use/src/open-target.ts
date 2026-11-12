/** Native AXURL/resource metadata. A missing or unreadable type is never navigation. */
export type OpenTargetKind = "directory" | "file" | "package" | "unknown";
export interface OpenTarget {
	kind: OpenTargetKind;
	/** Digest of the resolved URL and type; no filesystem path crosses the wire. */
	fingerprint: string;
}

/** Also covers a batch whose highest-tier action carries an external-open target. */
export function requiresOpenConfirmation(action?: { name: string; openTarget?: OpenTargetKind }): boolean {
	return (action?.name.split("+").includes("open") || action?.openTarget !== undefined) && action?.openTarget !== "directory";
}
