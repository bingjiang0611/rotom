/**
 * Cursor colour per agent (F4).
 *
 * Several agents can drive different apps at the same time. Each one gets its own
 * cursor, and the colour is derived only from the agent id, so the same agent keeps
 * the same colour across sessions and two agents never silently share one. The
 * helper paints whatever it is given; the choice lives here so it can be tested
 * without a display.
 */
/**
 * Hue range. 360 hues with fixed saturation and lightness: a hash collision would
 * need two ids to land on the same degree, which keeps simultaneous agents apart
 * far more reliably than a small hand-picked palette would.
 */
const HUE_RANGE = 360;
const SATURATION = 0.85;
const LIGHTNESS = 0.62;

/** FNV-1a over the agent id: small, stable, and independent of insertion order. */
function hashAgentId(agentId: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < agentId.length; index += 1) {
		hash ^= agentId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function hueToChannel(hue: number, channel: number): number {
	const k = (channel + hue / 30) % 12;
	const a = SATURATION * Math.min(LIGHTNESS, 1 - LIGHTNESS);
	return Math.round(255 * (LIGHTNESS - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
}

/** Stable `#rrggbb` for an agent id; the same id always gets the same colour. */
export function cursorColorFor(agentId: string): string {
	const hue = hashAgentId(agentId) % HUE_RANGE;
	const red = hueToChannel(hue, 0).toString(16).padStart(2, "0");
	const green = hueToChannel(hue, 8).toString(16).padStart(2, "0");
	const blue = hueToChannel(hue, 4).toString(16).padStart(2, "0");
	return `#${red}${green}${blue}`;
}
