import { Session } from "@ailoha/agent-core";
import { createCalculatorTool } from "@ailoha/agent-tools";
import { ChatCompletionsAdapter } from "@ailoha/chat-completions-adapter";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
	throw new Error("DEEPSEEK_API_KEY is missing. Copy .env.example to .env.local and set your key.");
}

const model = {
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "openai-completions",
	baseUrl: "https://api.deepseek.com",
	provider: "deepseek",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 384_000,
};

const adapter = new ChatCompletionsAdapter({ model, apiKey });

const modelRunner = {
	async run(context, { signal }) {
		return await adapter.complete({
			systemPrompt: context.systemPrompt,
			messages: [...context.messages],
			tools: [...context.tools],
		}, { signal });
	},
};

const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: [
			"You are testing an agent tool loop. You must call the calculator tool for arithmetic and then answer with the result.",
		],
	},
	configureTools: (manager) => manager.register("calculator", () => createCalculatorTool()),
	toolRequests: [{ name: "calculator" }],
});

const result = await session.agent.prompt("请务必调用 calculator 工具计算 (137 * 42) + 19，然后告诉我结果。");

for (const message of result.messages) {
	if (message.role === "assistant") {
		const toolCalls = message.content.filter((block) => block.type === "toolCall");
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		if (toolCalls.length > 0) console.log("assistant tool calls:", JSON.stringify(toolCalls, null, 2));
		if (text) console.log("assistant:", text);
	} else if (message.role === "toolResult") {
		console.log("tool result:", JSON.stringify(message, null, 2));
	}
}
await session.dispose();
