import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@ailoha/agent-core";

export interface ReadDocsToolOptions {
	readonly roots: readonly string[];
	readonly maxCharacters?: number;
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function createReadDocsTool(options: ReadDocsToolOptions): AgentTool {
	if (options.roots.length === 0) throw new Error("read_docs requires at least one allowed root.");
	const roots = options.roots.map((root) => path.resolve(root));
	const maxCharacters = Math.max(1, Math.floor(options.maxCharacters ?? 50_000));
	return {
		name: "read_docs",
		description: "Read a UTF-8 text document located under an allowed documentation root.",
		parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		async execute(toolCall, context) {
			const requestedPath = String(toolCall.arguments.path);
			try {
				for (const root of roots) {
					context.signal.throwIfAborted();
					const rootPath = await realpath(root);
					const candidate = path.resolve(root, requestedPath);
					if (!isInside(root, candidate)) continue;
					let actualPath: string;
					try {
						actualPath = await realpath(candidate);
					} catch {
						continue;
					}
					if (!isInside(rootPath, actualPath)) continue;
					const fileStat = await stat(actualPath);
					if (!fileStat.isFile()) return { content: `Not a file: ${requestedPath}`, isError: true };
					const fullContent = await readFile(actualPath, { encoding: "utf8", signal: context.signal });
					context.signal.throwIfAborted();
					const truncated = fullContent.length > maxCharacters;
					return {
						content: JSON.stringify({
							path: path.relative(rootPath, actualPath).split(path.sep).join("/"),
							content: fullContent.slice(0, maxCharacters),
							truncated,
						}),
					};
				}
				return { content: `Document not found or outside allowed roots: ${requestedPath}`, isError: true };
			} catch (error) {
				if (context.signal.aborted) context.signal.throwIfAborted();
				return { content: error instanceof Error ? error.message : String(error), isError: true };
			}
		},
	};
}
