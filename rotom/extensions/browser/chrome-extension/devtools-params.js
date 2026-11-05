// Relay-side devtools parameter validation and result bounding.
//
// The Pi side owns presets and product limits; this module only re-checks what it is
// handed, so a malformed payload is rejected before any CDP command runs, and a large
// page value cannot travel through one native message unbounded.

export const MAX_DEVTOOLS_EXPRESSION_CHARS_V1 = 8 * 1024;
export const MAX_DEVTOOLS_RESULT_BYTES_V1 = 64 * 1024;
export const DEVTOOLS_WORLDS_V1 = ["isolated", "main"];
export const DEVTOOLS_SCREENSHOT_FORMATS_V1 = ["png", "jpeg"];
export const MAX_EXPORT_WIDTH_V1 = 5_000;
export const MAX_EXPORT_HEIGHT_V1 = 20_000;
export const DEFAULT_EXPORT_QUALITY_V1 = 80;
const VIEWPORT_LIMIT = { min: 200, max: 5_000 };

function record(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeDevtoolsExpressionV1(value) {
	if (typeof value !== "string") return undefined;
	const expression = value.trim();
	if (expression.length === 0 || expression.length > MAX_DEVTOOLS_EXPRESSION_CHARS_V1 || expression.includes("\0")) return undefined;
	return expression;
}

export function sanitizeDevtoolsWorldV1(value) {
	if (value === undefined) return "isolated";
	return typeof value === "string" && DEVTOOLS_WORLDS_V1.includes(value) ? value : undefined;
}

/** `{viewport: "reset"}` clears the override; otherwise every field is required. */
export function sanitizeViewportOverrideV1(value) {
	if (value === "reset") return "reset";
	if (!record(value)) return undefined;
	const { width, height, deviceScaleFactor, mobile, touch, userAgent } = value;
	if (!Number.isInteger(width) || width < VIEWPORT_LIMIT.min || width > VIEWPORT_LIMIT.max) return undefined;
	if (!Number.isInteger(height) || height < VIEWPORT_LIMIT.min || height > VIEWPORT_LIMIT.max) return undefined;
	if (typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0 || deviceScaleFactor > 4) return undefined;
	if (typeof mobile !== "boolean" || typeof touch !== "boolean") return undefined;
	if (userAgent !== undefined && (typeof userAgent !== "string" || userAgent.length === 0 || userAgent.length > 512 || userAgent.includes("\0"))) return undefined;
	return { width, height, deviceScaleFactor, mobile, touch, ...(userAgent === undefined ? {} : { userAgent }) };
}

/** A service worker has atob/btoa but no Buffer: convert explicitly at the edges. */
export function bytesFromBase64V1(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function base64FromBytesV1(bytes) {
	let binary = "";
	const step = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += step) binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
	return btoa(binary);
}

/** Screenshot export request: format is explicit, quality only applies to JPEG. */
export function sanitizeExportRequestV1(payload) {
	const format = payload?.format;
	if (typeof format !== "string" || !DEVTOOLS_SCREENSHOT_FORMATS_V1.includes(format)) return undefined;
	if (payload.fullPage !== undefined && typeof payload.fullPage !== "boolean") return undefined;
	const quality = payload.quality === undefined ? DEFAULT_EXPORT_QUALITY_V1 : payload.quality;
	if (!Number.isInteger(quality) || quality < 1 || quality > 100) return undefined;
	return { format, fullPage: payload.fullPage === true, quality };
}

/** UTF-8 byte-bounded truncation that never splits a character. */
export function boundDevtoolsTextV1(text, maxBytes = MAX_DEVTOOLS_RESULT_BYTES_V1) {
	const encoded = new TextEncoder().encode(text);
	if (encoded.length <= maxBytes) return { text, truncated: false, bytes: encoded.length };
	let end = maxBytes;
	// A continuation byte (10xxxxxx) means the cut fell inside a character.
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	const cut = new TextDecoder().decode(encoded.subarray(0, end));
	return { text: cut, truncated: true, bytes: end };
}

/**
 * One CDP `Runtime.evaluate` reply becomes a bounded, model-safe record.
 * A thrown expression is reported as data (`threw: true`), not as a relay failure:
 * the caller still learns what the page said.
 */
export function devtoolsEvaluateRecordV1(reply, maxBytes = MAX_DEVTOOLS_RESULT_BYTES_V1) {
	const exception = reply?.exceptionDetails;
	const object = reply?.result;
	const type = typeof object?.type === "string" ? object.type : "undefined";
	let text;
	if (exception !== undefined) {
		const described = exception?.exception?.description ?? exception?.exception?.value ?? exception?.text;
		text = typeof described === "string" ? described : "evaluate threw";
	} else if (object === undefined) {
		text = "undefined";
	} else if ("value" in object) {
		const serialized = JSON.stringify(object.value ?? null);
		text = serialized === undefined ? String(object.value) : serialized;
	} else if (typeof object.unserializableValue === "string") {
		text = object.unserializableValue;
	} else if (typeof object.description === "string") {
		text = object.description;
	} else {
		text = type;
	}
	const bounded = boundDevtoolsTextV1(text, maxBytes);
	return { threw: exception !== undefined, type, valueText: bounded.text, truncated: bounded.truncated, bytes: bounded.bytes };
}

/** Describes the applied override without echoing the caller's payload back. */
export function viewportRecordV1(viewport) {
	if (viewport === "reset") return { reset: true, viewport: null };
	return {
		reset: false,
		viewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: viewport.mobile, touch: viewport.touch },
		...(viewport.userAgent === undefined ? {} : { userAgent: viewport.userAgent }),
	};
}
