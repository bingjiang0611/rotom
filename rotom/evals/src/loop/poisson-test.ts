/**
 * Exact one-sided Poisson rate test for the acceptance metric.
 *
 * Counts of a rare event in a fixed number of turns are Poisson with mean `rate × turns`. Comparing
 * two intervals from normal approximations overstates confidence at the counts these metrics
 * actually see (single digits to a few dozen events), so the verdict uses the exact tail instead.
 * The test is one-sided in the declared direction: "did the metric fall below the baseline" or "did
 * it rise above it". The threshold is a fixed 0.05; it is not tuned per record.
 */

/** `P(X ≥ k)` for Poisson mean `lambda`, in log space to stay finite far into the tail. */
export function poissonUpperTail(k: number, lambda: number): number {
	if (k <= 0) return 1;
	if (lambda <= 0) return 0;
	return 1 - gammaQ(k, lambda);
}

/** `P(X ≤ k)` for Poisson mean `lambda`. */
export function poissonLowerTail(k: number, lambda: number): number {
	if (k < 0) return 0;
	if (lambda <= 0) return 1;
	return gammaQ(k + 1, lambda);
}

/** `Q(a, x)` = regularized upper incomplete gamma, the Poisson survival function at `a = k + 1`. */
function gammaQ(a: number, x: number): number {
	if (x < a + 1) return 1 - gammaSeries(a, x);
	return gammaContinuedFraction(a, x);
}

function logGamma(z: number): number {
	// Lanczos approximation; z is always a small positive integer here.
	const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
	let y = z;
	let tmp = z + 5.5;
	tmp -= (z + 0.5) * Math.log(tmp);
	let ser = 1.000000000190015;
	for (const coefficient of g) ser += coefficient / ++y;
	return -tmp + Math.log((2.5066282746310005 * ser) / z);
}

function gammaSeries(a: number, x: number): number {
	let ap = a;
	let sum = 1 / a;
	let del = sum;
	for (let n = 0; n < 10_000; n++) {
		ap += 1;
		del *= x / ap;
		sum += del;
		if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
	}
	return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaContinuedFraction(a: number, x: number): number {
	const tiny = 1e-300;
	let b = x + 1 - a;
	let c = 1 / tiny;
	let d = 1 / b;
	let h = d;
	for (let i = 1; i <= 10_000; i++) {
		const an = -i * (i - a);
		b += 2;
		d = an * d + b;
		if (Math.abs(d) < tiny) d = tiny;
		c = b + an / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < 1e-15) break;
	}
	return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

export type RateVerdict = "improved" | "no-change" | "worse";

/** Fixed significance level. Declared once so a report cannot silently move it. */
export const RATE_TEST_ALPHA = 0.05;

/**
 * Compare `observed` events in `turns` against `baselinePer100`. `expect: "lower"` asks whether the
 * rate fell; `"higher"` asks whether it rose. A p above `RATE_TEST_ALPHA` is `no-change`: failing to
 * show a difference is not the same as showing none, which the note spells out.
 */
export function rateTest(input: { observed: number; turns: number; baselinePer100: number; expect: "lower" | "higher" }): {
	verdict: RateVerdict;
	pValue: number;
	expectedEvents: number;
	usedTail: "lower" | "upper";
} {
	const expectedEvents = (input.baselinePer100 / 100) * input.turns;
	const wantLower = input.expect === "lower";
	const pValue = wantLower ? poissonLowerTail(input.observed, expectedEvents) : poissonUpperTail(input.observed, expectedEvents);
	const usedTail = wantLower ? "lower" : "upper";
	if (pValue < RATE_TEST_ALPHA) return { verdict: wantLower ? "improved" : "worse", pValue, expectedEvents, usedTail };
	const opposite = wantLower ? poissonUpperTail(input.observed, expectedEvents) : poissonLowerTail(input.observed, expectedEvents);
	if (opposite < RATE_TEST_ALPHA) return { verdict: wantLower ? "worse" : "improved", pValue: opposite, expectedEvents, usedTail };
	return { verdict: "no-change", pValue, expectedEvents, usedTail };
}
