// Upload path guard. Everything here runs before a path reaches the relay, because a file
// the model asks to upload is exactly the kind of input that must not be able to leak
// credentials: the rules are deny-by-name and deny-by-shape, not "the model said it is fine".

import { lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";

/** Total size of one upload action. */
export const MAX_UPLOAD_TOTAL_BYTES_V1 = 10 * 1024 * 1024;
/** How many files one action may attach. */
export const MAX_UPLOAD_FILES_V1 = 10;

/** Secret-shaped file names and directories, matched case-insensitively per component. */
const DENIED_NAME_PATTERNS = [
	/^\.env/u,
	/\.pem$/u,
	/\.key$/u,
	/^id_/u,
	/^\.ssh$/u,
	/^\.aws$/u,
	/^\.gnupg$/u,
	/^\.netrc$/u,
	/^\.npmrc$/u,
];

function hitsDeniedNameV1(path) {
	return path.split(sep).filter(Boolean).some((component) => DENIED_NAME_PATTERNS.some((pattern) => pattern.test(component.toLowerCase())));
}

/** Why a single path is refused, or the size that was measured. */
export async function inspectUploadPathV1(path, options = {}) {
	if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return { ok: false, reason: "路径为空或含非法字符", path: String(path) };
	if (!isAbsolute(path)) return { ok: false, reason: "必须是绝对路径", path };
	const normalized = resolve(path);
	// Every component of both spellings is checked, so `/home/u/.ssh/id_rsa`,
	// `/tmp/.env.local` and a symlinked `/tmp/link/notes.txt` that resolves to
	// `~/.ssh/notes.txt` all fail. System-level links such as macOS `/var` are not a
	// reason to reject a path on their own, so the resolved path is checked by name
	// instead of being required to equal the given one.
	if (hitsDeniedNameV1(normalized)) return { ok: false, reason: "路径命中敏感文件名规则", path };
	let info;
	try { info = await (options.lstat ?? lstat)(normalized); }
	catch { return { ok: false, reason: "文件不存在或无法读取", path }; }
	if (info.isSymbolicLink()) return { ok: false, reason: "不接受符号链接", path };
	if (!info.isFile()) return { ok: false, reason: "只接受普通文件", path };
	if (info.nlink !== 1) return { ok: false, reason: "不接受硬链接（nlink > 1）", path };
	const resolved = await (options.realpath ?? realpath)(normalized).catch(() => undefined);
	if (resolved === undefined) return { ok: false, reason: "无法解析真实路径", path };
	if (basename(resolved) !== basename(normalized)) return { ok: false, reason: "真实文件与给定文件名不一致", path };
	if (hitsDeniedNameV1(resolved)) return { ok: false, reason: "真实路径命中敏感文件名规则", path };
	const size = (await (options.stat ?? stat)(normalized)).size;
	if (!Number.isSafeInteger(size) || size < 0) return { ok: false, reason: "无法确认文件大小", path };
	return { ok: true, path: normalized, name: basename(normalized), size };
}

/**
 * Validate one upload action. `lease` is the child lease when this session has one; a
 * child without `allow.upload` cannot upload at all, and the main agent (no lease) is not
 * gated here.
 */
export async function validateUploadPathsV1(input, options = {}) {
	const paths = input?.paths;
	if (!Array.isArray(paths) || paths.length === 0) throw new Error("upload 需要至少一个 paths");
	if (paths.length > MAX_UPLOAD_FILES_V1) throw new Error(`upload 单次最多 ${MAX_UPLOAD_FILES_V1} 个文件`);
	if (!input.allowUpload) throw new Error("当前 agent 的 lease 不允许 upload");
	const unique = [...new Set(paths)];
	if (unique.length !== paths.length) throw new Error("upload paths 不得重复");
	const files = [];
	let total = 0;
	for (const path of unique) {
		const inspected = await inspectUploadPathV1(path, options);
		if (!inspected.ok) throw new Error(`upload 被拒绝（${inspected.reason}）：${path}`);
		total += inspected.size;
		if (total > MAX_UPLOAD_TOTAL_BYTES_V1) throw new Error(`upload 总大小超过 ${MAX_UPLOAD_TOTAL_BYTES_V1} 字节`);
		files.push(inspected);
	}
	return files;
}
