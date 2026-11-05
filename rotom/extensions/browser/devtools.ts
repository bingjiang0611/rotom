import { createHash } from "node:crypto";

/** Product gate: `ROTOM_BROWSER_DEVTOOLS=0` must not register the tool at all. */
export const BROWSER_DEVTOOLS_ENV = "ROTOM_BROWSER_DEVTOOLS";
export const BROWSER_DEVTOOLS_TOOL_V1 = "browser_devtools" as const;

/**
 * Operations this product actually implements. Unlisted names are rejected locally
 * instead of reaching the relay, so a half-built operation can never look supported.
 */
export const DEVTOOLS_OPERATIONS_V1 = ["evaluate", "viewport", "screenshot_export"] as const;
export type DevtoolsOperationV1 = (typeof DEVTOOLS_OPERATIONS_V1)[number];

/** Isolated world by default: page globals stay out of reach unless the caller asks. */
export const DEVTOOLS_WORLDS_V1 = ["isolated", "main"] as const;
export type DevtoolsWorldV1 = (typeof DEVTOOLS_WORLDS_V1)[number];

export const MAX_DEVTOOLS_EXPRESSION_CHARS_V1 = 8 * 1024;
export const MAX_DEVTOOLS_RESULT_BYTES_V1 = 64 * 1024;
export const DEVTOOLS_EVALUATE_TIMEOUT_MS_V1 = 10_000;
export const DEVTOOLS_VIEWPORT_WAIT_MS_V1 = 2_000;
/** A full-page capture is one image: bound each edge before asking the renderer. */
export const MAX_EXPORT_WIDTH_V1 = 5_000;
export const MAX_EXPORT_HEIGHT_V1 = 20_000;
export const DEFAULT_EXPORT_QUALITY_V1 = 80;
/** The isolated world name the relay creates; one world per document. */
export const DEVTOOLS_ISOLATED_WORLD_V1 = "rotom-devtools";

export type ViewportOverrideV1 = {
	width: number;
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
	touch: boolean;
};

export const DEVTOOLS_VIEWPORT_PRESETS_V1: Readonly<Record<string, ViewportOverrideV1>> = {
	"iphone-15": { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true },
	"pixel-8": { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
	"ipad": { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
	"desktop-1440": { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
};

const VIEWPORT_LIMIT = { min: 200, max: 5_000 };

export function devtoolsEnabledByEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
	const configured = environment[BROWSER_DEVTOOLS_ENV];
	return configured === undefined || !/^(?:0|false|no)$/iu.test(configured.trim());
}

export function sanitizeDevtoolsOperationV1(value: unknown): DevtoolsOperationV1 | undefined {
	return typeof value === "string" && (DEVTOOLS_OPERATIONS_V1 as readonly string[]).includes(value)
		? (value as DevtoolsOperationV1)
		: undefined;
}

export function sanitizeDevtoolsWorldV1(value: unknown): DevtoolsWorldV1 | undefined {
	if (value === undefined) return "isolated";
	return typeof value === "string" && (DEVTOOLS_WORLDS_V1 as readonly string[]).includes(value)
		? (value as DevtoolsWorldV1)
		: undefined;
}

export function sanitizeDevtoolsExpressionV1(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const expression = value.trim();
	if (expression.length === 0 || expression.length > MAX_DEVTOOLS_EXPRESSION_CHARS_V1) return undefined;
	if (expression.includes("\0")) return undefined;
	return expression;
}

/** `reset`, a preset name, or an explicit override. Numbers are bounded here, not in the relay. */
export function resolveViewportV1(value: unknown): ViewportOverrideV1 | "reset" | undefined {
	if (value === "reset") return "reset";
	if (typeof value === "string") {
		const preset = DEVTOOLS_VIEWPORT_PRESETS_V1[value];
		return preset === undefined ? undefined : { ...preset };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<ViewportOverrideV1>;
	const { width, height, deviceScaleFactor, mobile, touch } = candidate;
	if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
	if (width < VIEWPORT_LIMIT.min || width > VIEWPORT_LIMIT.max) return undefined;
	if (height < VIEWPORT_LIMIT.min || height > VIEWPORT_LIMIT.max) return undefined;
	if (typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0 || deviceScaleFactor > 4) return undefined;
	if (typeof mobile !== "boolean" || typeof touch !== "boolean") return undefined;
	return { width, height, deviceScaleFactor, mobile, touch };
}

export function sanitizeExportQualityV1(value: unknown): number | undefined {
	if (value === undefined) return DEFAULT_EXPORT_QUALITY_V1;
	return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100 ? (value as number) : undefined;
}

export function viewportPresetNamesV1(): string[] {
	return Object.keys(DEVTOOLS_VIEWPORT_PRESETS_V1);
}

/** Audit keeps a digest of the code, never the code itself. */
export function devtoolsCodeDigestV1(code: string): string {
	return createHash("sha256").update(code, "utf8").digest("hex");
}

export function viewportDescriptionV1(viewport: ViewportOverrideV1 | "reset"): string {
	if (viewport === "reset") return "reset";
	return `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}`;
}

/** UTF-8 byte-bounded text, so a multi-byte character is never split in half. */
export function boundDevtoolsTextV1(value: string, maxBytes = MAX_DEVTOOLS_RESULT_BYTES_V1): { text: string; truncated: boolean; bytes: number } {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.length <= maxBytes) return { text: value, truncated: false, bytes: encoded.length };
	const cut = encoded.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
	return { text: cut, truncated: true, bytes: Buffer.byteLength(cut, "utf8") };
}
