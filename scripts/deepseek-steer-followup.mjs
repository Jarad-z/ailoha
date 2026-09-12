import { Session } from "@ailoha/agent-core";
import { Type } from "@earendil-works/pi-ai";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { createCalculatorTool } from "@ailoha/agent-tools";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing.");

const model = getModel("deepseek", "deepseek-v4-flash");
if (!model) throw new Error("The installed pi-ai catalog does not contain the DeepSeek model.");

function describeMessage(message) {
	if (message.role === "user") return `user: ${typeof message.content === "string" ? message.content : "[rich content]"}`;
	if (message.role === "toolResult") return `toolResult: ${message.toolName}`;
	const calls = message.content.filter((block) => block.type === "toolCall").map((block) => block.name);
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	return `assistant: ${calls.length > 0 ? `toolCalls=[${calls.join(", ")}]` : text.slice(0, 80)}`;
}

let modelCalls = 0;
const snapshots = [];
const modelRunner = {
	async run(context, { signal }) {
		modelCalls++;
		const snapshot = context.messages.map(describeMessage);
		snapshots.push(snapshot);
		console.log(`\n=== model call #${modelCalls} input ===`);
		console.log(snapshot.join("\n"));
		const response = await completeSimple(
			model,
			{
				systemPrompt: context.systemPrompt,
				messages: [...context.messages],
				tools: [...context.tools],
			},
			{ apiKey, signal },
		);
		console.log(`=== model call #${modelCalls} output ===`);
		console.log(describeMessage(response));
		return response;
	},
};

let agent;
const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: [
			"This is a steer/follow-up queue test. For the initial request, call checkpoint exactly once before answering. " +
				"Treat a [STEER] user message as an immediate change to the current task and satisfy it before finishing the current answer. " +
				"Treat a [FOLLOW_UP] user message as a new question after the current answer; answer it briefly. " +
				"Use calculator for requested arithmetic.",
		],
	},
	configureTools: (manager) => {
		manager.register("calculator", () => createCalculatorTool());
		manager.register("checkpoint", () => ({
			name: "checkpoint",
			description: "Create a deterministic pause point used to inject steer and follow-up messages during an active run.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute() {
				agent.steer({
					role: "user",
					content: "[STEER] 当前任务增加一个要求：必须调用 calculator 计算 6 * 7，并在当前回答中报告结果。",
					timestamp: Date.now(),
				});
				agent.followUp({
					role: "user",
					content: "[FOLLOW_UP] 追问：刚才的计算结果再加 8 是多少？直接回答即可。",
					timestamp: Date.now() + 1,
				});
				console.log("\n[checkpoint] steer and followUp accepted while phase=react");
				return { content: "checkpoint reached" };
			},
		}));
	},
	toolRequests: [{ name: "checkpoint" }, { name: "calculator" }],
});
agent = session.agent;

const result = await agent.prompt("先调用 checkpoint，然后告诉我检查点是否完成。");

console.log("\n=== summary ===");
console.log(JSON.stringify({ modelCalls, finalStatus: agent.state.status }));
console.log("final history:");
console.log(result.messages.map(describeMessage).join("\n"));
await session.dispose();
