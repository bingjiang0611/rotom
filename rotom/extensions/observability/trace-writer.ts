import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TraceRecord } from "./trace-schema.ts";

const TRACE_DIRECTORY = "observability";
const TRACE_FLUSH_TIMEOUT_MS = 500;

export function localTracePathForSessionFile(sessionFile: string): string {
	const fileName = basename(sessionFile).replace(/\.jsonl$/u, "");
	return join(dirname(sessionFile), TRACE_DIRECTORY, `${fileName}.trace.jsonl`);
}

async function ensurePrivateTraceDirectory(path: string): Promise<void> {
	let metadata;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(path, { mode: 0o700 });
		metadata = await lstat(path);
	}
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("trace directory is not a private directory");
	if ((metadata.mode & 0o077) !== 0 || !ownerIsCurrent(metadata)) throw new Error("trace directory permissions are not private");
}

function ownerIsCurrent(metadata: any): boolean {
	return !process.getuid || metadata.uid === process.getuid();
}

export class LocalTraceWriterV1 {
	readonly path: string;
	private chain: Promise<void> = Promise.resolve();
	private failed = false;
	private enqueued = 0;
	private closeRequested = false;
	private handle?: Awaited<ReturnType<typeof open>>;
	private identity?: { dev: number; ino: number };
	private readonly appendLine?: (path: string, line: string) => Promise<void>;
	recordsWritten = 0;
	recordsDropped = 0;

	constructor(path: string, appendLine?: (path: string, line: string) => Promise<void>) {
		this.path = path;
		this.appendLine = appendLine;
	}

	private async openPrivateHandle(): Promise<Awaited<ReturnType<typeof open>>> {
		await ensurePrivateTraceDirectory(dirname(this.path));
		const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
		const handle = await open(this.path, flags, 0o600);
		try {
			const opened = await handle.stat();
			const current = await lstat(this.path);
			if (!opened.isFile() || (opened.mode & 0o077) !== 0 || !ownerIsCurrent(opened)
				|| current.isSymbolicLink() || !current.isFile() || (current.mode & 0o077) !== 0 || !ownerIsCurrent(current)
				|| opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("trace path changed or is not private");
			this.identity = { dev: opened.dev, ino: opened.ino };
			return handle;
		} catch (error) { await handle.close().catch(() => {}); throw error; }
	}

	private async verifyPath(): Promise<void> {
		// The open descriptor's identity is immutable. Two pathname lstats are
		// sufficient to detect file replacement/symlinks and permission drift on
		// both the file and its parent, without another fstat or post-write probe.
		const [directory, current] = await Promise.all([lstat(dirname(this.path)), lstat(this.path)]);
		if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || !ownerIsCurrent(directory)
			|| !current.isFile() || (current.mode & 0o077) !== 0 || !ownerIsCurrent(current)
			|| this.identity!.dev !== current.dev || this.identity!.ino !== current.ino) throw new Error("trace path changed or is not private");
	}

	private async writeLine(line: string): Promise<void> {
		if (this.appendLine) { await this.appendLine(this.path, line); return; }
		if (this.handle) await this.verifyPath();
		else this.handle = await this.openPrivateHandle();
		await this.handle.writeFile(line, { encoding: "utf8" });
	}

	private noteDrop(): void {
		if (this.recordsDropped < this.enqueued - this.recordsWritten) this.recordsDropped += 1;
	}

	private async closeHandle(): Promise<void> {
		const handle = this.handle;
		this.handle = undefined;
		if (handle) await handle.close().catch(() => {});
	}

	append(record: TraceRecord): void {
		this.enqueued += 1;
		if (this.failed || this.closeRequested) { this.noteDrop(); return; }
		this.chain = this.chain.then(async () => {
			if (this.failed) { this.noteDrop(); return; }
			try { await this.writeLine(`${JSON.stringify(record)}\n`); this.recordsWritten += 1; }
			catch { this.failed = true; this.noteDrop(); }
		});
	}

	async flush(timeoutMs = TRACE_FLUSH_TIMEOUT_MS): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		const completed = await Promise.race([
			this.chain.then(() => true),
			new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); }),
		]);
		if (timer) clearTimeout(timer);
		if (!completed) {
			this.failed = true;
			this.recordsDropped = Math.max(this.recordsDropped, this.enqueued - this.recordsWritten);
		}
		return completed;
	}

	async close(timeoutMs = TRACE_FLUSH_TIMEOUT_MS): Promise<boolean> {
		if (!this.closeRequested) {
			this.closeRequested = true;
			// Drain already accepted writes; reject later appends immediately. Closing
			// remains queued even when the bounded caller stops waiting.
			this.chain = this.chain.then(() => this.closeHandle());
		}
		return this.flush(timeoutMs);
	}
	get healthy(): boolean { return !this.failed; }
}
