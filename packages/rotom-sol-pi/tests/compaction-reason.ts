import { expect } from "vitest";

/**
 * rotom: the reason Pi reports for an extension-requested compaction. Upstream
 * Pi 1.3.0 reports `manual`; Pi 0.85 and rotom's Pi fork report `extension`.
 * The instructions and every other assertion stay exact.
 */
export const EXTENSION_COMPACTION_REASON = expect.stringMatching(/^(manual|extension)$/u);
