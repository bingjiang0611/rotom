/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REDUCER_EVENT_SCHEMA, REDUCER_EVENT_TYPE, type ReducerConfig } from "./config.ts";
import type { ProviderResult } from "./provider.ts";

/** Pi usage-entry kind for reducer model calls. */
export const REDUCER_USAGE_KIND = "sol_pi_reducer";

/**
 * Append one non-context session entry per decision the reducer made.
 *
 * The entries never enter the LLM context. They record which results were
 * candidates, which were delegated, and why each fallback happened.
 */
export type Journal = (kind: string, data?: object) => void;

export function createJournal(pi: ExtensionAPI, config: ReducerConfig): Journal {
	return (kind, data = {}) => {
		pi.appendEntry(REDUCER_EVENT_TYPE, {
			schema: REDUCER_EVENT_SCHEMA,
			runId: config.runId,
			kind,
			...data,
		});
	};
}

type AppendUsage = (kind: string, provider: string, model: string, usage: Usage, note?: string) => void;
export type UsageRecorder = (provider: ProviderResult) => void;

/**
 * Record each reducer response in Pi's usage entries so footer, session stats
 * and budgets include the reducer spend. Pi releases without
 * `pi.appendUsage` (upstream Pi) keep only the journal record.
 */
export function createUsageRecorder(pi: ExtensionAPI): UsageRecorder {
	const appendUsage = (pi as ExtensionAPI & { appendUsage?: AppendUsage }).appendUsage;
	if (typeof appendUsage !== "function") return () => {};
	return (provider) => {
		appendUsage.call(pi, REDUCER_USAGE_KIND, provider.provider, provider.responseModel, provider.responseUsage);
	};
}
