/**
 * The acceptance half of the weekly report: what each shipped-but-unmeasured record can claim, and
 * whether the turns it counts come from builds that actually contain the change.
 */
import type { RateInterval } from "./harvest-breakdown.ts";
import type { Incident, SessionSummary } from "./harvest.ts";
import type { LedgerEntry } from "./ledger.ts";
import { RATE_TEST_ALPHA, rateTest } from "./poisson-test.ts";

export type AcceptanceStatus = "improved" | "no-change" | "worse" | "insufficient-exposure" | "no-metric";

export type AcceptanceRow = {
	id: string;
	title: string;
	status: AcceptanceStatus;
	/** What was counted, e.g. `provider_error where category=429`. */
	metric: string | null;
	turns: number;
	observedPer100: number | null;
	baselinePer100: number | null;
	interval?: RateInterval;
	/** Turns the record declared as its exposure: where the baseline predicts ten events. */
	minimumTurns: number | null;
	/** Days of recent traffic that exposure still needs, at the last seven days' average. */
	daysToExposure: number | null;
	/** Sessions in the window whose build commit could not be proven; unknown, never counted. */
	buildUnknown?: number;
	note: string;
};

/** Events per 100 turns, rounded to one decimal. */
const ratePer100 = (count: number, turns: number) => (turns > 0 ? Math.round((count / turns) * 1000) / 10 : null);

/** Turns per day over the trailing week, so an exposure requirement reads as days, not abstraction. */
export function recentTurnsPerDay(sessions: readonly SessionSummary[], now = new Date(), days = 7): number {
	const since = now.getTime() - days * 24 * 60 * 60 * 1000;
	const turns = sessions.filter((session) => Date.parse(session.startedAt) >= since).reduce((sum, session) => sum + session.userTurns, 0);
	return turns / days;
}

/**
 * Only data after the record's own acceptance start counts. Below the record's declared exposure
 * the row is `insufficient-exposure` (暴露不足): a run of zero events there is what the baseline
 * predicts, so calling it "no change" or "improved" would dress noise up as a finding.
 *
 * At or above the exposure, the verdict is an exact one-sided Poisson rate test against the
 * baseline rate (`rateTest`, alpha 0.05). Below the alpha the row is `improved` or `worse` in the
 * declared direction; otherwise `no-change`, which means "not shown to differ" and nothing more.
 */
export function acceptanceRows(ledger: readonly LedgerEntry[], sessions: readonly SessionSummary[], incidents: readonly Incident[], now = new Date(), ranWithFix?: (session: SessionSummary, firstCommit: string) => boolean): AcceptanceRow[] {
	const turnsPerDay = recentTurnsPerDay(sessions, now);
	const daysFor = (minimumTurns: number, turns: number) => {
		if (turns >= minimumTurns) return 0;
		if (turnsPerDay <= 0) return null;
		return Math.ceil((minimumTurns - turns) / turnsPerDay);
	};
	return ledger
		.filter((entry) => entry.decision === "shipped" && entry.evidence === "unmeasured")
		.map((entry) => {
			const acceptance = entry.acceptance;
			if (!acceptance) {
				return { id: entry.id, title: entry.title, status: "no-metric" as const, metric: null, turns: 0, observedPer100: null, baselinePer100: null, minimumTurns: null, daysToExposure: null, note: "the entry declares no harvest-measurable acceptance metric; its evidence is a gate or eval result" };
			}
			if (new Date(acceptance.startedAt).getTime() > now.getTime()) {
				return { id: entry.id, title: entry.title, status: "insufficient-exposure" as const, metric: acceptance.metric, turns: 0, observedPer100: null, baselinePer100: acceptance.baselinePer100, minimumTurns: acceptance.minimumTurns, daysToExposure: daysFor(acceptance.minimumTurns, 0), note: `acceptance window opens ${acceptance.startedAt}; exposure needs ${acceptance.minimumTurns} turns` };
			}
			const since = Date.parse(acceptance.startedAt);
			const firstCommit = acceptance.firstCommit;
			// Without a way to tell which sessions ran the fix, the honest count is none: calling
			// every turn after a date "exposure to this change" is what this field exists to stop.
			const ranFix = (session: SessionSummary) => Boolean(firstCommit && session.buildCommit && (ranWithFix?.(session, firstCommit) ?? false));
			const inWindow = sessions.filter((session) => Date.parse(session.startedAt) >= since);
			const counted = inWindow.filter(ranFix);
			const withoutFix = firstCommit === undefined ? 0 : inWindow.filter((session) => session.buildCommit && !ranFix(session)).length;
			const countedIds = new Set(counted.map((session) => session.sessionId));
			// A session with no provable build commit tells us nothing about exposure either way, so
			// it is counted on its own line instead of being folded into the unexposed group.
			const buildUnknown = inWindow.filter((session) => !session.buildCommit).length;
			const exclusions = `${firstCommit ? "" : "; record has no firstCommit; exposure is unknown"}${withoutFix ? `; ${withoutFix} known builds without the fix are not counted` : ""}${buildUnknown ? `; ${buildUnknown} sessions have no build commit and count as unknown` : ""}`;
			const turns = counted.reduce((sum, session) => sum + session.userTurns, 0);
			// Both sides of the rate must come from the same period: an incident recorded before the
			// fix shipped belongs to the baseline, not to the observed rate.
			const matching = incidents.filter((incident) => {
				if (!countedIds.has(incident.sessionId) || incident.kind !== acceptance.incident) return false;
				if (Date.parse(incident.timestamp) < since) return false;
				const [key, value] = acceptance.detail ?? [];
				return key === undefined || String(incident.detail[key]) === value;
			});
			const observed = ratePer100(matching.length, turns);
			const interval = poissonBand(matching.length, turns);
			const base = { id: entry.id, title: entry.title, metric: acceptance.metric, buildUnknown, turns, observedPer100: observed, baselinePer100: acceptance.baselinePer100, minimumTurns: acceptance.minimumTurns, daysToExposure: daysFor(acceptance.minimumTurns, turns), ...(interval ? { interval } : {}) };
			if (turns < acceptance.minimumTurns) {
				const days = base.daysToExposure;
				return { ...base, status: "insufficient-exposure" as const, note: `${turns} of ${acceptance.minimumTurns} turns since ${acceptance.startedAt}${days === null ? "" : `, about ${days} more days at the last week's rate`}${exclusions}` };
			}
			const test = rateTest({ observed: matching.length, turns, baselinePer100: acceptance.baselinePer100, expect: acceptance.expect });
			const exposure = `${matching.length} events against ${Number(test.expectedEvents.toFixed(1))} expected`;
			return {
				...base,
				status: test.verdict,
				note: `${exposure}; one-sided exact Poisson p=${Number(test.pValue.toFixed(4))} (alpha ${RATE_TEST_ALPHA}) → ${test.verdict}${exclusions}`,
			};
		})
		.sort((left, right) => left.id.localeCompare(right.id));
}

/** The 95% band used by the provider-failure section too. */
export function poissonBand(count: number, turns: number): RateInterval | undefined {
	if (turns <= 0) return undefined;
	const rate = count / turns;
	const spread = (1.96 * Math.sqrt(count)) / turns;
	return { low: Math.max(0, Math.round((rate - spread) * 1000) / 10), high: Math.round((rate + spread) * 1000) / 10 };
}
