import { Session } from "@ailoha/agent-core";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { createCalculatorTool } from "@ailoha/agent-tools";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
	throw new Error("DEEPSEEK_API_KEY is missing. Copy .env.example to .env.local and set your key.");
}

const model = getModel("deepseek", "deepseek-v4-flash");
if (!model) throw new Error("The installed pi-ai catalog does not contain the DeepSeek model.");

const modelRunner = {
	async run(context, { signal }) {
		return await completeSimple(
			model,
			{
				systemPrompt: context.systemPrompt,
				messages: [...context.messages],
				tools: [...context.tools],
			},
			{ apiKey, signal },
		);
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
