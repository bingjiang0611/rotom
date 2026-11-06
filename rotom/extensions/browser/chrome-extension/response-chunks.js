// Split one large relay response into frames a single native message can carry.
//
// The service worker serializes the response once, hashes that exact text, and
// slices it by UTF-16 code units. Slicing by code unit keeps every frame a valid
// JavaScript string: a surrogate pair split across two frames is re-escaped by
// JSON and restored by concatenation, so no multi-byte character is corrupted.
// The receiver checks the concatenated text against the digest, then parses it.

/** Above this size a response travels as chunks instead of one frame. */
export const RESPONSE_CHUNK_THRESHOLD_BYTES = 256 * 1024;
/** ~192 KiB worst case (4 UTF-8 bytes per code unit), under the 256 KiB frame contract. */
export const RESPONSE_CHUNK_CODE_UNITS = 48_000;
/** Upper bound on one reassembled response; the transport cap, not a model limit. */
export const RESPONSE_MAX_BYTES = 12 * 1024 * 1024;

export function responseChunkCountV1(codeUnits) {
	return Math.max(1, Math.ceil(codeUnits / RESPONSE_CHUNK_CODE_UNITS));
}

/**
 * @param {string} text already-serialized response message
 * @returns {Promise<{ digest: string, chunks: string[] }>}
 */
export async function responseChunksV1(text) {
	if (new TextEncoder().encode(text).length > RESPONSE_MAX_BYTES) throw new Error("native response too large to send");
	const digest = await sha256HexV1(text);
	const chunks = [];
	for (let offset = 0; offset < text.length; offset += RESPONSE_CHUNK_CODE_UNITS) chunks.push(text.slice(offset, offset + RESPONSE_CHUNK_CODE_UNITS));
	return { digest, chunks: chunks.length > 0 ? chunks : [""] };
}

/**
 * Frames to post for one response: the message itself when it fits, otherwise
 * numbered chunks carrying the digest of the whole serialized message.
 * @param {Record<string, unknown>} message a complete `kind: "response"` message
 * @returns {Promise<object[]>}
 */
export async function responseFramesV1(message) {
	const encoded = JSON.stringify(message);
	if (new TextEncoder().encode(encoded).length <= RESPONSE_CHUNK_THRESHOLD_BYTES) return [message];
	const { digest, chunks } = await responseChunksV1(encoded);
	return chunks.map((data, index) => ({
		schemaVersion: 1,
		kind: "response-chunk",
		id: message.id,
		sessionId: message.sessionId,
		generation: message.generation,
		chunk: { index, count: chunks.length, sha256: digest, data },
	}));
}

/** SHA-256 of the UTF-8 encoding of `text`, lowercase hex. */
export async function sha256HexV1(text) {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
