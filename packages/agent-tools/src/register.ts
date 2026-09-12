import type { ToolManager, ToolRequest } from "@ailoha/agent-core";
import { createCalculatorTool } from "./calculator.js";
import { createReadDocsTool, type ReadDocsToolOptions } from "./read-docs.js";
import { createSearchTool, type SearchToolOptions } from "./search.js";
import { createTodoTool, type TodoToolOptions } from "./todo.js";
import { createWeatherTool, type WeatherToolOptions } from "./weather.js";

export interface AgentToolsOptions {
	readonly calculator?: false;
	readonly search?: false | SearchToolOptions;
	readonly readDocs?: false | ReadDocsToolOptions;
	readonly todo?: false | TodoToolOptions;
	readonly weather?: false | WeatherToolOptions;
}

function readRoots(request: ToolRequest): readonly string[] | undefined {
	const roots = request.options?.roots;
	return Array.isArray(roots) && roots.every((root) => typeof root === "string") ? roots : undefined;
}

export function registerAgentTools(manager: ToolManager, options: AgentToolsOptions = {}): void {
	if (options.calculator !== false) manager.register("calculator", () => createCalculatorTool());
	if (options.search !== false) manager.register("search", () => createSearchTool(options.search || {}));
	const readDocsOptions = options.readDocs;
	if (readDocsOptions !== false) {
		manager.register("read_docs", (request) => {
			const roots = readDocsOptions?.roots ?? readRoots(request);
			if (!roots) throw new Error("read_docs requires roots in registration options or ToolRequest options.");
			return createReadDocsTool({
				roots,
				maxCharacters: readDocsOptions?.maxCharacters,
			});
		});
	}
	if (options.todo !== false) manager.register("todo", () => createTodoTool(options.todo || {}));
	if (options.weather !== false) manager.register("weather", () => createWeatherTool(options.weather || {}));
}
