import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { composeGifV1, decodePngV1, encodeGifV1, framesToIndicesV1, gifPaletteV1, lzwEncodeV1, paletteIndexV1 } from "./gif-encoder.ts";

// --- helpers that build real PNG bytes, so the decoder is tested against the format ---

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();
function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}
function pngOf({ width, height, channels, rows }) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 4 ? 6 : 2;
	const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), Buffer.from(row)])));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** Independent GIF LZW reader (prefix/suffix tables), following the format's own rules. */
function lzwDecode(bytes, minCodeSize) {
	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	const prefix = new Int32Array(4096).fill(-1);
	const suffix = new Uint8Array(4096);
	for (let code = 0; code < clearCode; code += 1) suffix[code] = code;
	const stack = new Uint8Array(4096);
	let codeSize = minCodeSize + 1;
	let nextCode = endCode + 1;
	let previous = -1;
	let bitBuffer = 0;
	let bitCount = 0;
	let position = 0;
	const output = [];
	while (true) {
		while (bitCount < codeSize && position < bytes.length) {
			bitBuffer |= bytes[position] << bitCount;
			position += 1;
			bitCount += 8;
		}
		if (bitCount < codeSize) break;
		const code = bitBuffer & ((1 << codeSize) - 1);
		bitBuffer >>>= codeSize;
		bitCount -= codeSize;
		if (code === clearCode) {
			codeSize = minCodeSize + 1;
			nextCode = endCode + 1;
			previous = -1;
			continue;
		}
		if (code === endCode) break;
		let current = code;
		let top = 0;
		if (current === nextCode) {
			// KwKwK: the code being defined right now, one character longer than previous.
			stack[top++] = 0;
			current = previous;
		}
		while (current >= clearCode) {
			if (current >= 4096) throw new Error("bad LZW stream");
			stack[top++] = suffix[current];
			current = prefix[current];
			if (current < 0) throw new Error("bad LZW stream");
		}
		stack[top++] = current;
		const first = stack[top - 1];
		while (top > 0) output.push(stack[--top]);
		if (previous !== -1 && nextCode < 4096) {
			prefix[nextCode] = previous;
			suffix[nextCode] = first;
			nextCode += 1;
			if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
		}
		previous = code;
	}
	return output;
}

test("PNG 解码读出真实像素（RGB 与 RGBA，含 filter 类型）", () => {
	const rgb = decodePngV1(pngOf({ width: 2, height: 1, channels: 3, rows: [[255, 0, 0, 0, 255, 0]] }));
	assert.equal(rgb.width, 2);
	assert.equal(rgb.height, 1);
	assert.equal(rgb.channels, 3);
	assert.deepEqual([...rgb.pixels], [255, 0, 0, 0, 255, 0]);

	const rgba = decodePngV1(pngOf({ width: 1, height: 2, channels: 4, rows: [[10, 20, 30, 255], [40, 50, 60, 128]] }));
	assert.equal(rgba.channels, 4);
	assert.deepEqual([...rgba.pixels], [10, 20, 30, 255, 40, 50, 60, 128]);

	// filter 1 (Sub) on the second row: each byte is stored as itself minus its left
	// neighbour, so [10,20,30, 0,0,0] restores to [10,20,30, 10,20,30] across 2 pixels.
	const subHeader = Buffer.alloc(13);
	subHeader.writeUInt32BE(2, 0); subHeader.writeUInt32BE(2, 4); subHeader[8] = 8; subHeader[9] = 2;
	const sub = decodePngV1(Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", subHeader),
		chunk("IDAT", deflateSync(Buffer.from([0, 10, 20, 30, 10, 20, 30, 1, 10, 20, 30, 0, 0, 0]))),
		chunk("IEND", Buffer.alloc(0)),
	]));
	assert.deepEqual([...sub.pixels], [10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30], "Sub 过滤器必须逐字节还原");
});

test("不支持的 PNG 形状按名字拒绝", () => {
	const notPng = Buffer.from("GIF89a----");
	assert.throws(() => decodePngV1(notPng), /不是 PNG/u);
	// 16-bit RGB
	const ihdr16 = Buffer.alloc(13);
	ihdr16.writeUInt32BE(1, 0); ihdr16.writeUInt32BE(1, 4); ihdr16[8] = 16; ihdr16[9] = 2;
	assert.throws(() => decodePngV1(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr16), chunk("IEND", Buffer.alloc(0))])), /位深/u);
	// palette colour type
	const ihdrPalette = Buffer.alloc(13);
	ihdrPalette.writeUInt32BE(1, 0); ihdrPalette.writeUInt32BE(1, 4); ihdrPalette[8] = 8; ihdrPalette[9] = 3;
	assert.throws(() => decodePngV1(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdrPalette), chunk("IEND", Buffer.alloc(0))])), /颜色类型/u);
});

test("3-3-2 调色板与索引映射覆盖全范围", () => {
	assert.equal(gifPaletteV1().length, 768);
	assert.equal(paletteIndexV1(0, 0, 0), 0);
	assert.equal(paletteIndexV1(255, 255, 255), 255);
	assert.equal(paletteIndexV1(255, 0, 0), 0b11100000);
	assert.equal(paletteIndexV1(0, 255, 0), 0b00011100);
	assert.equal(paletteIndexV1(0, 0, 255), 3);
});

test("LZW 编码能被独立解码器还原成原始索引", () => {
	const indices = new Uint8Array([1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 1, 1, 2, 0, 255, 128]);
	const encoded = lzwEncodeV1(indices, 8);
	assert.ok(encoded.length > 0);
	assert.deepEqual(lzwDecode(Uint8Array.from(encoded), 8), [...indices]);
	// A longer run that forces code-size growth still round-trips.
	const long = Uint8Array.from({ length: 5_000 }, (_, index) => (index * 7) % 256);
	assert.deepEqual(lzwDecode(Uint8Array.from(lzwEncodeV1(long, 8)), 8), [...long]);
});

test("GIF 结构：头、尺寸、循环扩展、每帧延迟、尾字节", () => {
	const frames = framesToIndicesV1([
		decodePngV1(pngOf({ width: 2, height: 2, channels: 3, rows: [[255, 0, 0, 0, 255, 0], [0, 0, 255, 255, 255, 255]] })),
	], 2, 2);
	const gif = encodeGifV1(frames, { width: 2, height: 2, delayMs: 500 });
	assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a");
	assert.equal(gif.readUInt16LE(6), 2);
	assert.equal(gif.readUInt16LE(8), 2);
	assert.equal(gif[10], 0xf7, "全局色表 256 色");
	assert.ok(gif.includes(Buffer.from("NETSCAPE2.0", "ascii")), "必须无限循环");
	assert.equal(gif[gif.length - 1], 0x3b, "必须以 trailer 结束");
	const delays = [];
	for (let index = 0; index < gif.length - 3; index += 1) if (gif[index] === 0x21 && gif[index + 1] === 0xf9) delays.push(gif.readUInt16LE(index + 4));
	assert.deepEqual(delays, [50], "500 ms 的帧 = 50 个 1/100 秒");

	const twoFrames = encodeGifV1([frames[0], frames[0]], { width: 2, height: 2, delayMs: 500 });
	const count = [];
	for (let index = 0; index < twoFrames.length - 3; index += 1) if (twoFrames[index] === 0x2c) count.push(index);
	assert.equal(count.length, 2, "两帧必须有两个图像描述符");
});

test("composeGifV1：缩放、帧数与空输入", () => {
	const png = pngOf({ width: 4, height: 4, channels: 3, rows: Array.from({ length: 4 }, () => [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]) });
	const composed = composeGifV1([png, png, png], { delayMs: 500, maxWidth: 2, maxHeight: 2 });
	assert.equal(composed.frames, 3);
	assert.equal(composed.width, 2);
	assert.equal(composed.height, 2);
	assert.equal(composed.gif.subarray(0, 6).toString("ascii"), "GIF89a");
	assert.throws(() => composeGifV1([], { delayMs: 500 }), /没有帧/u);
});
