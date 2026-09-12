import type { AgentTool, ToolFactory, ToolInitContext, ToolRequest } from "./types.js";
import { awaitWithAbortCheck } from "./utils.js";

export class ToolManager {
	readonly #factories = new Map<string, ToolFactory>();

	register(name: string, factory: ToolFactory): void {
		if (!name) throw new Error("Tool factory name cannot be empty.");
		if (this.#factories.has(name)) throw new Error(`Tool factory already registered: ${name}`);
		this.#factories.set(name, factory);
	}

	async instantiate(requests: readonly ToolRequest[], context: ToolInitContext): Promise<AgentTool[]> {
		const tools: AgentTool[] = [];
		for (const request of requests) {
			context.signal.throwIfAborted();
			const factory = this.#factories.get(request.name);
			if (!factory) throw new Error(`Unknown tool: ${request.name}`);
			const tool = await awaitWithAbortCheck(Promise.resolve(factory(request, context)), context.signal);
			if (tool.name !== request.name) {
				throw new Error(`Tool factory for ${request.name} returned tool named ${tool.name}.`);
			}
			tools.push(tool);
		}
		return tools;
	}
}
