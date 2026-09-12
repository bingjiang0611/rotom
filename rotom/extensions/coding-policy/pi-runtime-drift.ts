import { existsSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/**
 * Diagnoses one specific, opaque runtime failure: the pi bundle is rebuilt
 * while a session is still running, so a lazily imported provider chunk with a
 * hashed filename disappears and every later request dies with a bare
 * `Cannot find module '.../dist/bundle/chunks/<name>-<hash>.js'`.
 *
 * The crash itself is the honest outcome — the process cannot recover a module
 * that no longer exists on disk, and silently loading a newer chunk would mix
 * module versions inside one running graph. What was missing is attribution:
 * the message names a file, not the cause, so the run looks like a provider
 * outage and gets retried. We only rewrite the operator-facing explanation, and
 * only when the missing module is provably a chunk of the running bundle that
 * is now gone.
 */

export const PI_RUNTIME_DRIFT_MARKER = "pi 运行时 bundle 在本会话运行期间被替换";

const MISSING_MODULE = /Cannot find module '([^']+)'/u;

export interface RuntimeDriftProbe {
	exists?: (path: string) => boolean;
	mtimeMs?: (path: string) => number | undefined;
	/** Entry file of the running pi bundle, normally process.argv[1]. */
	entryPath?: string;
	processStartMs?: number;
}

function defaultExists(path: string): boolean {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}

function defaultMtimeMs(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

function isBundleChunk(missingPath: string, entryPath: string | undefined): boolean {
	const directory = dirname(missingPath);
	if (entryPath && directory === join(dirname(entryPath), "chunks")) return true;
	return directory.endsWith(`${sep}dist${sep}bundle${sep}chunks`) || directory.endsWith("/dist/bundle/chunks");
}

function iso(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms)) return undefined;
	return new Date(ms).toISOString();
}

export function piRuntimeDriftDiagnosis(errorMessage: string | undefined, probe: RuntimeDriftProbe = {}): string | undefined {
	if (!errorMessage || errorMessage.includes(PI_RUNTIME_DRIFT_MARKER)) return undefined;
	const missingPath = MISSING_MODULE.exec(errorMessage)?.[1];
	if (!missingPath) return undefined;
	const entryPath = probe.entryPath ?? process.argv[1];
	if (!isBundleChunk(missingPath, entryPath)) return undefined;
	const exists = probe.exists ?? defaultExists;
	if (exists(missingPath)) return undefined;
	const chunksDirectory = dirname(missingPath);
	const rebuiltAt = iso((probe.mtimeMs ?? defaultMtimeMs)(chunksDirectory));
	const startedAt = iso(probe.processStartMs ?? Date.now() - Math.round(process.uptime() * 1000));
	const evidence = [
		`缺失 chunk '${missingPath.slice(chunksDirectory.length + 1)}'`,
		rebuiltAt ? `chunks 目录 ${chunksDirectory} 最近修改 ${rebuiltAt}` : `chunks 目录 ${chunksDirectory}`,
		startedAt ? `本进程启动于 ${startedAt}` : undefined,
	].filter((part): part is string => Boolean(part));
	return `${PI_RUNTIME_DRIFT_MARKER}：${evidence.join("；")}。当前进程无法再加载该模块，重试同一请求不会恢复：请重启 rotom 会话后重试。若你正在本机重建 pi，请先结束存活会话再执行构建。原始错误：${errorMessage}`;
}
