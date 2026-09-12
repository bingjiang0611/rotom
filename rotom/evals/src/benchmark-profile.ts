export const BENCHMARK_PROFILE_SCHEMA_V1 = "dev-agent-benchmark-profile/v1";

export const SUPPORTED_BENCHMARKS = ["swe-bench-multilingual", "terminal-bench-2", "terminal-bench-2.1"] as const;
export type SupportedBenchmark = (typeof SUPPORTED_BENCHMARKS)[number];

export type BenchmarkProfileEntryV1 = {
	benchmark: SupportedBenchmark;
	taskId: string;
};

const supportedBenchmarks = new Set<string>(SUPPORTED_BENCHMARKS);
const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export function parseBenchmarkProfileV1(content: string): BenchmarkProfileEntryV1[] {
	const entries: BenchmarkProfileEntryV1[] = [];
	const seen = new Set<string>();
	let schemaSeen = false;
	for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
		const line = rawLine.trim();
		if (!line) continue;
		if (!schemaSeen) {
			if (line !== `# ${BENCHMARK_PROFILE_SCHEMA_V1}`) throw new Error(`Benchmark profile line ${index + 1} must declare '# ${BENCHMARK_PROFILE_SCHEMA_V1}'.`);
			schemaSeen = true;
			continue;
		}
		if (line.startsWith("#")) continue;
		const parts = line.split(/\s+/u);
		if (parts.length !== 2) throw new Error(`Benchmark profile line ${index + 1} must be '<benchmark> <task-id>'.`);
		const [benchmark, taskId] = parts;
		if (!supportedBenchmarks.has(benchmark)) throw new Error(`Benchmark profile line ${index + 1} has unsupported benchmark '${benchmark}'.`);
		if (!taskIdPattern.test(taskId) || taskId.length > 512) throw new Error(`Benchmark profile line ${index + 1} has invalid task id '${taskId}'.`);
		const key = `${benchmark}\0${taskId}`;
		if (seen.has(key)) throw new Error(`Benchmark profile line ${index + 1} duplicates '${benchmark} ${taskId}'.`);
		seen.add(key);
		entries.push({ benchmark: benchmark as SupportedBenchmark, taskId });
	}
	if (!schemaSeen) throw new Error(`Benchmark profile must declare '# ${BENCHMARK_PROFILE_SCHEMA_V1}'.`);
	if (entries.length === 0) throw new Error("Benchmark profile must contain at least one task.");
	return entries;
}
