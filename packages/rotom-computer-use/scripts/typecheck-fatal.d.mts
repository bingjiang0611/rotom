export function typecheckResult(result: {
	stdout?: string;
	stderr?: string;
	status: number | null;
	signal?: string | null;
	error?: Error;
}): { output: string; diagnosticCount: number; fatalCodes: number[]; exitCode: number };
