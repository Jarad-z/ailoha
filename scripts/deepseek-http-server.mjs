import {
	createAgentServiceHttpServer,
	AgentServiceRuntime,
	loadAgentServiceTraceConfig,
} from "../packages/agent-service/dist/index.js";
import { registerAgentTools } from "../packages/agent-tools/dist/index.js";
import { ChatCompletionsAdapter } from "../packages/chat-completions-adapter/dist/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing.");

const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const model = {
	id: modelId,
	name: "DeepSeek Live HTTP Model",
	api: "openai-completions",
	baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
	provider: "deepseek",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 384_000,
};

const runtime = new AgentServiceRuntime({
	traceConfig: loadAgentServiceTraceConfig(),
	resolveSessionOptions(profile) {
		if (profile.modelId !== model.id) throw new Error(`Model is not allowlisted: ${profile.modelId}`);
		const adapter = new ChatCompletionsAdapter({ model, apiKey });
		return {
			model,
			createModelRunner: () => ({
				async run(context, { signal }) {
					return await adapter.complete({
						systemPrompt: context.systemPrompt,
						messages: [...context.messages],
						tools: [...context.tools],
					}, { signal });
				},
			}),
			contextManagerOptions: {
				systemPrompts: profile.systemPrompts,
				maxTurns: profile.maxTurns,
			},
			configureTools(manager) {
				registerAgentTools(manager, {
					search: false,
					readDocs: false,
					todo: false,
					weather: false,
				});
			},
			toolRequests: profile.tools,
		};
	},
});

const server = createAgentServiceHttpServer(runtime, {
	authenticate(request) {
		const ownerId = request.headers["x-owner-id"];
		if (typeof ownerId !== "string" || ownerId.trim() === "") throw new Error("Missing x-owner-id.");
		return { ownerId };
	},
});

const requestedPort = Number(process.env.PORT ?? "0");
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
	throw new Error("PORT must be an integer between 0 and 65535.");
}

await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(requestedPort, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("HTTP server did not expose a TCP address.");
console.log(`READY http://127.0.0.1:${address.port} model=${model.id}`);

let closing;
async function close() {
	if (closing) return await closing;
	closing = (async () => {
		const serverClosed = new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		server.closeAllConnections();
		await serverClosed;
		await runtime.dispose();
	})();
	return await closing;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => {
		void close().then(
			() => process.exit(0),
			(error) => {
				console.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			},
		);
	});
}
