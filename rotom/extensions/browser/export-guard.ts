// Export path guard for `browser_devtools screenshot_export`.
//
// The relay hands back bytes; where they land is a local write the model asked for. The
// rules are: inside the current project directory, never through a symlink, and never a
// silent overwrite of something that is not a plain file.

import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Same ceiling the relay applies to one screenshot capture, so Pi never promises more.
export const MAX_EXPORT_BYTES_V1 = 8 * 1024 * 1024;
export const EXPORT_FORMATS_V1 = ["png", "jpeg"] as const;
export type ExportFormatV1 = (typeof EXPORT_FORMATS_V1)[number];

const FORMAT_BY_EXTENSION = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg" } as const;

export type ExportTargetV1 = {
	/** Absolute path that will be written. */
	path: string;
	/** Path relative to the project directory, the only spelling the model gets back. */
	relativePath: string;
	format: ExportFormatV1;
	exists: boolean;
};

export function exportFormatForPathV1(path: string, requested?: unknown): ExportFormatV1 | undefined {
	const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
	const fromPath = FORMAT_BY_EXTENSION[extension as keyof typeof FORMAT_BY_EXTENSION];
	if (requested === undefined) return fromPath;
	if (typeof requested !== "string" || !(EXPORT_FORMATS_V1 as readonly string[]).includes(requested)) return undefined;
	// A `.png` target cannot receive JPEG bytes: refuse instead of writing a mislabelled file.
	if (fromPath !== undefined && fromPath !== requested) return undefined;
	return requested as ExportFormatV1;
}

export async function resolveExportTargetV1(input: { path: unknown; cwd: string; format?: unknown }): Promise<{ ok: true; target: ExportTargetV1 } | { ok: false; reason: string }> {
	const { path, cwd, format } = input;
	if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return { ok: false, reason: "path 必须是非空且不含 NUL 的字符串" };
	const root = resolve(cwd);
	const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
	const inside = relative(root, absolute);
	if (inside.length === 0) return { ok: false, reason: `path 必须是 ${root} 内的文件，不能是目录本身` };
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { ok: false, reason: `path 必须在当前项目目录 ${root} 内` };
	const resolvedFormat = exportFormatForPathV1(absolute, format);
	if (resolvedFormat === undefined) return { ok: false, reason: "format 只能是 png 或 jpeg，且必须与文件扩展名一致" };
	let exists = false;
	try {
		const stats = await lstat(absolute);
		// Writing through a link would escape the project directory the check just made.
		if (stats.isSymbolicLink()) return { ok: false, reason: "path 不能是符号链接" };
		if (stats.isDirectory()) return { ok: false, reason: "path 是目录，不能当文件写" };
		if (!stats.isFile()) return { ok: false, reason: "path 不是普通文件" };
		exists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `无法检查目标文件：${(error as Error).message}` };
	}
	return { ok: true, target: { path: absolute, relativePath: inside, format: resolvedFormat, exists } };
}
