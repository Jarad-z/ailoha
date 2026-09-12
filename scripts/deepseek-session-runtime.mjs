import { SessionRuntime } from "@ailoha/agent-core";
import { registerAgentTools } from "@ailoha/agent-tools";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing.");

const model = getModel("deepseek", "deepseek-v4-flash");
if (!model) throw new Error("The installed pi-ai catalog does not contain the DeepSeek model.");

const runtime = new SessionRuntime();
const modelCalls = new Map();

function createOptions(sessionId, ownMarker, forbiddenMarker) {
	return {
		model,
		createModelRunner: (factoryContext) => ({
			async run(context, { signal }) {
				if (factoryContext.sessionId !== sessionId) throw new Error(`Factory session ID mismatch for ${sessionId}.`);
				if (JSON.stringify(context.messages).includes(forbiddenMarker)) {
					throw new Error(`Context leaked from another Session into ${sessionId}.`);
				}
				modelCalls.set(sessionId, (modelCalls.get(sessionId) ?? 0) + 1);
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
		}),
		contextManagerOptions: {
			systemPrompts: [
				`You are the isolated test agent for Session ${sessionId}. ` +
					`Your isolation marker is ${ownMarker}. ` +
					"Follow the requested todo tool steps exactly. Never invent tool results.",
			],
		},
		configureTools(manager) {
			registerAgentTools(manager, {
				calculator: false,
				search: false,
				readDocs: false,
				weather: false,
			});
		},
		toolRequests: [{ name: "todo" }],
	};
}

function toolPayloads(result) {
	return result.messages
		.filter((message) => message.role === "toolResult" && message.toolName === "todo")
		.flatMap((message) => message.content)
		.filter((content) => content.type === "text")
		.map((content) => {
			try {
				return JSON.parse(content.text);
			} catch {
				return undefined;
			}
		})
		.filter(Boolean);
}

function listedItems(payloads) {
	return payloads.flatMap((payload) => (Array.isArray(payload.items) ? payload.items : []));
}

try {
	const [alpha, beta] = await Promise.all([
		runtime.createSession({
			id: "deepseek-alpha",
			session: createOptions("deepseek-alpha", "ALPHA_ONLY_9281", "BETA_ONLY_5734"),
		}),
		runtime.createSession({
			id: "deepseek-beta",
			session: createOptions("deepseek-beta", "BETA_ONLY_5734", "ALPHA_ONLY_9281"),
		}),
	]);

	const startedAt = Date.now();
	const [alphaResult, betaResult] = await Promise.all([
		alpha.agent.prompt(
			'先调用 todo add 添加“ALPHA_ONLY_9281”，等待结果后再调用 todo list，最后确认列表中存在该项。',
		),
		beta.agent.prompt('只调用一次 todo list，不要添加任何项目；最后确认列表为空。标识 BETA_ONLY_5734。'),
	]);
	const elapsedMs = Date.now() - startedAt;

	const alphaItems = listedItems(toolPayloads(alphaResult));
	const betaItems = listedItems(toolPayloads(betaResult));
	if (!alphaItems.some((item) => item.text === "ALPHA_ONLY_9281")) {
		throw new Error("Alpha Session did not retain its own todo item.");
	}
	if (betaItems.length !== 0) throw new Error("Beta Session observed non-empty todo state.");

	console.log(
		"session runtime smoke test passed:",
		JSON.stringify({
			concurrent: true,
			contextIsolation: true,
			toolIsolation: true,
			alphaModelCalls: modelCalls.get("deepseek-alpha"),
			betaModelCalls: modelCalls.get("deepseek-beta"),
			alphaListedItems: alphaItems.length,
			betaListedItems: betaItems.length,
			elapsedMs,
		}),
	);
} finally {
	await runtime.dispose();
}
