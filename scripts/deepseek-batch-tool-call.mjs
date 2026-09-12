import { Session } from "@ailoha/agent-core";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { registerAgentTools } from "@ailoha/agent-tools";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing.");

const model = getModel("deepseek", "deepseek-v4-flash");
if (!model) throw new Error("The installed pi-ai catalog does not contain the DeepSeek model.");

let modelCallNumber = 0;
const toolCallsPerModelCall = [];
const modelRunner = {
	async run(context, { signal }) {
		modelCallNumber++;
		const response = await completeSimple(
			model,
			{
				systemPrompt: context.systemPrompt,
				messages: [...context.messages],
				tools: [...context.tools],
			},
			{ apiKey, signal },
		);
		const calls = response.content.filter((block) => block.type === "toolCall");
		toolCallsPerModelCall.push(calls.length);
		console.log(`model call #${modelCallNumber}: ${calls.length} tool call(s)`);
		if (calls.length > 0) console.log(JSON.stringify(calls, null, 2));
		return response;
	},
};

const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: [
			"This is a batch tool-call test. On your first response, emit exactly three tool calls together in the same assistant message: " +
				"one calculator call, one weather call, and one todo add call. They are independent, so do not wait for one result before issuing another. " +
				"Do not emit explanatory text before the calls. After receiving all three results, answer briefly in Chinese without calling more tools.",
		],
	},
	configureTools: (manager) => registerAgentTools(manager, { search: false, readDocs: false }),
	toolRequests: [{ name: "calculator" }, { name: "weather" }, { name: "todo" }],
});

const result = await session.agent.prompt(
	"批量完成三个互不依赖的任务：计算 256 / 8 + 7；查询 Beijing 的摄氏天气；添加待办“验证批量工具调用”。",
);

const toolResults = result.messages.filter((message) => message.role === "toolResult");
console.log(
	"summary:",
	JSON.stringify({ modelCalls: modelCallNumber, toolCallsPerModelCall, toolResults: toolResults.length }),
);
for (const message of toolResults) {
	console.log(`tool result [${message.toolName}]:`, JSON.stringify(message.content));
}
console.log(
	"final:",
	result.finalAssistantMessage?.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(""),
);
await session.dispose();
