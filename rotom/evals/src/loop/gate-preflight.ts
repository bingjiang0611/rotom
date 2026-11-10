/**
 * Preflight the two products a gate run compares, before any model call.
 *
 * A gate run costs real money, and a product whose installed packages disagree
 * with its own lock or `fork-build.json` scores nothing: the run either dies in
 * the harness or, worse, measures a build nobody declared. Both arms are checked
 * here — installed fork packages against `fork-build.json`, installed third-party
 * packages against `extensions/third-party/package-lock.json` — and a mismatch
 * refuses the run with the directory to reinstall.
 *
 * This reads files only. It does not reimplement product startup checks: the
 * release still validates its own identity when a session starts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProductLabel = "baseline" | "candidate";

export type PreflightProblem = {
	readonly label: ProductLabel;
	/** Product directory as given, so the message names what to reinstall. */
	readonly product: string;
	/** Directory inside the product that has to be reinstalled. */
	readonly directory: string;
	readonly detail: string;
};

export type ProductIdentity = {
	readonly label: ProductLabel;
	readonly product: string;
	readonly version: string;
	readonly fork: string;
};

export type PreflightResult = { readonly products: ProductIdentity[]; readonly problems: PreflightProblem[] };

type Json = Record<string, unknown>;

function readJson(path: string): Json | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Json;
	} catch {
		return undefined;
	}
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function short(sha: unknown): string {
	const value = text(sha);
	return value ? value.slice(0, 12) : "none";
}

/** Installed fork packages must match the build identity the product declares. */
function checkFork(product: string, label: ProductLabel, problems: PreflightProblem[]): string | undefined {
	const runtime = join(product, "runtime", "pi");
	const build = readJson(join(runtime, "fork-build.json"));
	const version = text(build?.version);
	const sourceSha256 = text(build?.sourceSha256);
	const revision = text(build?.upstreamRevision);
	const artifacts = build?.artifacts;
	if (!build || !version || !sourceSha256 || !revision || !artifacts || typeof artifacts !== "object") {
		problems.push({ label, product, directory: "runtime/pi", detail: "fork-build.json is missing or unreadable, so no fork build can be identified" });
		return undefined;
	}
	for (const [name, artifact] of Object.entries(artifacts as Record<string, Json>)) {
		const declared = text(artifact?.version);
		const installed = readJson(join(runtime, "node_modules", name, "package.json"));
		if (!installed) {
			problems.push({ label, product, directory: "runtime/pi", detail: `${name} is not installed, so the runtime cannot start` });
			continue;
		}
		const fork = installed.rotomFork as Json | undefined;
		if (text(installed.version) !== declared) {
			problems.push({ label, product, directory: "runtime/pi", detail: `installed ${name} is ${text(installed.version) ?? "unversioned"}, fork-build.json declares ${declared ?? "nothing"}` });
		} else if (text(fork?.sourceSha256) !== sourceSha256 || text(fork?.revision) !== revision) {
			// Same version, different bytes: the product was repacked after this copy was installed.
			problems.push({
				label,
				product,
				directory: "runtime/pi",
				detail: `installed ${name} was built from source ${short(fork?.sourceSha256)} (revision ${short(fork?.revision)}), the product declares source ${short(sourceSha256)} (revision ${short(revision)})`,
			});
		}
	}
	return version;
}

/** Installed third-party packages must match the versions the lock pins. */
function checkThirdParty(product: string, label: ProductLabel, problems: PreflightProblem[]): void {
	const root = join(product, "extensions", "third-party");
	const lock = readJson(join(root, "package-lock.json"));
	const packages = lock?.packages as Record<string, Json> | undefined;
	if (!packages || typeof packages !== "object") {
		problems.push({ label, product, directory: "extensions/third-party", detail: "package-lock.json is missing or unreadable, so no dependency set can be identified" });
		return;
	}
	for (const [path, entry] of Object.entries(packages)) {
		if (!path.startsWith("node_modules/") || entry?.link === true) continue;
		const locked = text(entry?.version);
		if (!locked) continue;
		const name = path.slice("node_modules/".length);
		const installed = readJson(join(root, "node_modules", name, "package.json"));
		if (!installed) {
			problems.push({ label, product, directory: "extensions/third-party", detail: `${name} is not installed, the lock pins ${locked}` });
			continue;
		}
		if (text(installed.version) !== locked) {
			problems.push({ label, product, directory: "extensions/third-party", detail: `installed ${name} is ${text(installed.version) ?? "unversioned"}, the lock pins ${locked}` });
		}
	}
}

function preflightProduct(product: string, label: ProductLabel): { identity: ProductIdentity; problems: PreflightProblem[] } {
	const problems: PreflightProblem[] = [];
	const manifest = readJson(join(product, "package.json"));
	const fork = checkFork(product, label, problems);
	checkThirdParty(product, label, problems);
	const version = text(manifest?.version) ?? "unknown build";
	return { identity: { label, product, version, fork: fork ?? "unknown fork" }, problems };
}

/** Reads both products; returns what they claim to be plus every inconsistency found. */
export function preflightGate(products: readonly { product: string; label: ProductLabel }[]): PreflightResult {
	const identities: ProductIdentity[] = [];
	const problems: PreflightProblem[] = [];
	for (const { product, label } of products) {
		const result = preflightProduct(product, label);
		identities.push(result.identity);
		problems.push(...result.problems);
	}
	return { products: identities, problems };
}

/** One line per product for the log, so every run records which builds it compared. */
export function describeProducts(products: readonly ProductIdentity[]): string[] {
	return products.map((item) => `[gate] ${item.label} ${item.version} (fork ${item.fork}): ${item.product}`);
}

/** The refusal message: what is wrong, and which directory fixes it. */
export function preflightFailure(problems: readonly PreflightProblem[]): string {
	const lines = problems.map((problem) => `  ${problem.label} ${problem.directory}: ${problem.detail} → reinstall ${join(problem.product, problem.directory)}`);
	return `gate refused before any model call: an installed product does not match its own lock/build identity\n${lines.join("\n")}`;
}

/** Whether a product directory even looks like a rotom product. */
export function isProductDirectory(product: string): boolean {
	return existsSync(join(product, "runtime", "resolve-installed-pi.mjs"));
}
