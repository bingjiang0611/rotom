export declare const GUARD_MARKER: string;
export declare const PATH_TOOLS: readonly string[];
export declare function pathArguments(toolName: string, input: Record<string, unknown>): string[];
export declare function resolveReal(path: string): string;
export declare function decideFileAccess(toolName: string, input: Record<string, unknown>, roots: readonly string[]): string | undefined;
