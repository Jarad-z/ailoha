import { Session } from "@ailoha/agent-core";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { registerAgentTools } from "@ailoha/agent-tools";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing.");

const model = getModel("deepseek", "deepseek-v4-flash");
if (!model) throw new Error("The installed pi-ai catalog does not contain the DeepSeek model.");

let modelCalls = 0;
const modelRunner = {
	async run(context, { signal }) {
		modelCalls++;
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
			"You are testing a multi-step agent tool loop. Follow every requested tool step exactly. " +
				"Do not invent tool results and do not provide the final answer until every requested tool call has succeeded.",
		],
	},
	configureTools: (manager) => registerAgentTools(manager, { search: false, readDocs: false }),
	toolRequests: [{ name: "calculator" }, { name: "todo" }, { name: "weather" }],
});

const result = await session.agent.prompt(
	[
		"请完成下面所有步骤：",
		"1. 调用 calculator 计算 (88 * 17) - 9。",
		"2. 调用 todo 添加一项“检查多工具调用”，必须等 add 返回后再调用 todo list 确认它存在。",
		"3. 调用 weather 查询 Shanghai 的摄氏温度。",
		"4. 全部工具完成后，用中文汇总计算结果、待办状态和天气。",
	].join("\n"),
);

let toolCallCount = 0;
for (const message of result.messages) {
	if (message.role === "assistant") {
		const calls = message.content.filter((block) => block.type === "toolCall");
		toolCallCount += calls.length;
		if (calls.length > 0) console.log("assistant tool calls:", JSON.stringify(calls, null, 2));
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		if (text) console.log("assistant:", text);
	} else if (message.role === "toolResult") {
		console.log(`tool result [${message.toolName}]:`, JSON.stringify(message.content));
	}
}

console.log("summary:", JSON.stringify({ modelCalls, toolCallCount }));
await session.dispose();
