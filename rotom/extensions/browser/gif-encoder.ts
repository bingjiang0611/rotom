// Pure-JS PNG decode + GIF encode, so `record_stop` can build an animation without adding
// an npm dependency.
//
// Only what a Chrome screencast actually produces is accepted: 8-bit RGB or RGBA, not
// interlaced. Anything else is refused by name instead of being decoded wrong.

import { inflateSync } from "node:zlib";

export type DecodedPngV1 = { width: number; height: number; channels: number; pixels: Uint8Array };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePngV1(bytes: Uint8Array): DecodedPngV1 {
	for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
		if (bytes[index] !== PNG_SIGNATURE[index]) throw new Error("不是 PNG 数据");
	}
	let offset = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Uint8Array[] = [];
	while (offset + 8 <= bytes.length) {
		const length = readUint32(bytes, offset);
		const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
		const data = bytes.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = readUint32(data, 0);
			height = readUint32(data, 4);
			const bitDepth = data[8];
			const colorType = data[9];
			const interlace = data[12];
			if (bitDepth !== 8) throw new Error(`PNG 位深 ${bitDepth} 不支持（只支持 8 位）`);
			if (colorType === 2) channels = 3;
			else if (colorType === 6) channels = 4;
			else throw new Error(`PNG 颜色类型 ${colorType} 不支持（只支持 RGB/RGBA）`);
			if (interlace !== 0) throw new Error("不支持隔行 PNG");
			if (width === 0 || height === 0) throw new Error("PNG 尺寸无效");
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		offset += 12 + length;
	}
	if (width === 0 || height === 0) throw new Error("PNG 缺少 IHDR");
	if (idat.length === 0) throw new Error("PNG 缺少 IDAT");
	const raw = inflateSync(concatBytes(idat));
	const stride = width * channels;
	const pixels = new Uint8Array(stride * height);
	for (let row = 0; row < height; row += 1) {
		const filter = raw[row * (stride + 1)];
		const source = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
		const target = pixels.subarray(row * stride, (row + 1) * stride);
		const previous = row === 0 ? undefined : pixels.subarray((row - 1) * stride, row * stride);
		unfilterRowV1(filter, source, target, previous, channels);
	}
	return { width, height, channels, pixels };
}

function unfilterRowV1(filter: number, source: Uint8Array, target: Uint8Array, previous: Uint8Array | undefined, channels: number): void {
	for (let index = 0; index < source.length; index += 1) {
		const left = index >= channels ? target[index - channels] : 0;
		const up = previous === undefined ? 0 : previous[index];
		const upLeft = previous === undefined || index < channels ? 0 : previous[index - channels];
		let value = source[index];
		if (filter === 0) {
			// nothing to add
		} else if (filter === 1) value += left;
		else if (filter === 2) value += up;
		else if (filter === 3) value += Math.floor((left + up) / 2);
		else if (filter === 4) {
			const estimate = left + up - upLeft;
			const distanceLeft = Math.abs(estimate - left);
			const distanceUp = Math.abs(estimate - up);
			const distanceUpLeft = Math.abs(estimate - upLeft);
			value += distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left : distanceUp <= distanceUpLeft ? up : upLeft;
		} else throw new Error(`PNG 行过滤类型 ${filter} 不支持`);
		target[index] = value & 0xff;
	}
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		merged.set(part, offset);
		offset += part.length;
	}
	return merged;
}

/** 3-3-2 palette: no quantisation pass, and every screenshot maps into it deterministically. */
export function paletteIndexV1(red: number, green: number, blue: number): number {
	return ((red >> 5) << 5) | ((green >> 5) << 2) | (blue >> 6);
}

export function gifPaletteV1(): Uint8Array {
	const palette = new Uint8Array(256 * 3);
	for (let index = 0; index < 256; index += 1) {
		palette[index * 3] = Math.round((((index >> 5) & 0x07) * 255) / 7);
		palette[index * 3 + 1] = Math.round((((index >> 2) & 0x07) * 255) / 7);
		palette[index * 3 + 2] = Math.round((index & 0x03) * 255 / 3);
	}
	return palette;
}

/** Indexed frames at `width`x`height`, palettised with 3-3-2 and scaled by nearest neighbour. */
export function framesToIndicesV1(frames: DecodedPngV1[], width: number, height: number): Uint8Array[] {
	return frames.map((frame) => {
		const indices = new Uint8Array(width * height);
		for (let y = 0; y < height; y += 1) {
			const sourceY = Math.min(frame.height - 1, Math.floor((y * frame.height) / height));
			for (let x = 0; x < width; x += 1) {
				const sourceX = Math.min(frame.width - 1, Math.floor((x * frame.width) / width));
				const pixel = (sourceY * frame.width + sourceX) * frame.channels;
				indices[y * width + x] = paletteIndexV1(frame.pixels[pixel], frame.pixels[pixel + 1], frame.pixels[pixel + 2]);
			}
		}
		return indices;
	});
}

class ByteWriter {
	private readonly parts: number[] = [];
	write(value: number) { this.parts.push(value & 0xff); return this; }
	writeShort(value: number) { this.parts.push(value & 0xff, (value >> 8) & 0xff); return this; }
	writeBytes(bytes: ArrayLike<number>) { for (const byte of Array.from(bytes)) this.parts.push(byte & 0xff); return this; }
	writeAscii(text: string) { for (const character of text) this.parts.push(character.charCodeAt(0)); return this; }
	toBuffer() { return Buffer.from(this.parts); }
}

/** GIF-flavoured LZW: 8-bit indices, clear code first, grow the code size like the spec says. */
export function lzwEncodeV1(indices: Uint8Array, minCodeSize: number): number[] {
	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	const output: number[] = [];
	let codeSize = minCodeSize + 1;
	let nextCode = endCode + 1;
	let dictionary = new Map<number, number>();
	let bitBuffer = 0;
	let bitCount = 0;
	const flush = (code: number) => {
		bitBuffer |= code << bitCount;
		bitCount += codeSize;
		while (bitCount >= 8) {
			output.push(bitBuffer & 0xff);
			bitBuffer >>= 8;
			bitCount -= 8;
		}
	};
	flush(clearCode);
	let prefix = indices[0];
	for (let index = 1; index < indices.length; index += 1) {
		const next = indices[index];
		const key = (prefix << 8) | next;
		const existing = dictionary.get(key);
		if (existing !== undefined) {
			prefix = existing;
			continue;
		}
		flush(prefix);
		dictionary.set(key, nextCode);
		nextCode += 1;
		// The reader only learns a table entry after the code that follows it, so the
		// writer grows one code later than the value alone would suggest.
		if (nextCode > 1 << codeSize && codeSize < 12) codeSize += 1;
		if (nextCode >= 4096) {
			flush(clearCode);
			dictionary = new Map();
			nextCode = endCode + 1;
			codeSize = minCodeSize + 1;
		}
		prefix = next;
	}
	flush(prefix);
	flush(endCode);
	if (bitCount > 0) output.push(bitBuffer & 0xff);
	return output;
}

export function encodeGifV1(frames: Uint8Array[], options: { width: number; height: number; delayMs: number }): Buffer {
	if (frames.length === 0) throw new Error("GIF 至少需要一帧");
	const { width, height, delayMs } = options;
	const delay = Math.max(1, Math.round(delayMs / 10));
	const writer = new ByteWriter();
	writer.writeAscii("GIF89a").writeShort(width).writeShort(height);
	// Packed: global colour table, 8-bit colour resolution, 256 entries.
	writer.write(0xf7).write(0).write(0);
	writer.writeBytes(gifPaletteV1());
	// Loop forever: application extension NETSCAPE2.0 with repeat=0.
	writer.write(0x21).write(0xff).write(11).writeAscii("NETSCAPE2.0").write(3).write(1).writeShort(0).write(0);
	for (const frame of frames) {
		writer.write(0x21).write(0xf9).write(4).write(0x04).writeShort(delay).write(0).write(0);
		writer.write(0x2c).writeShort(0).writeShort(0).writeShort(width).writeShort(height).write(0);
		writer.write(8);
		const compressed = lzwEncodeV1(frame, 8);
		for (let offset = 0; offset < compressed.length; offset += 255) {
			const block = compressed.slice(offset, offset + 255);
			writer.write(block.length).writeBytes(block);
		}
		writer.write(0);
	}
	writer.write(0x3b);
	return writer.toBuffer();
}

/** Decode + scale + concatenate, the whole `record_stop` pipeline in one place. */
export function composeGifV1(pngFrames: Uint8Array[], options: { delayMs: number; maxWidth?: number; maxHeight?: number }): { gif: Buffer; width: number; height: number; frames: number } {
	if (pngFrames.length === 0) throw new Error("录制没有帧");
	const decoded = pngFrames.map((frame) => decodePngV1(frame));
	const widest = Math.max(...decoded.map((frame) => frame.width));
	const tallest = Math.max(...decoded.map((frame) => frame.height));
	const scale = Math.min(1, (options.maxWidth ?? 320) / widest, (options.maxHeight ?? 240) / tallest);
	const width = Math.max(1, Math.round(widest * scale));
	const height = Math.max(1, Math.round(tallest * scale));
	const indices = framesToIndicesV1(decoded, width, height);
	return { gif: encodeGifV1(indices, { width, height, delayMs: options.delayMs }), width, height, frames: indices.length };
}
