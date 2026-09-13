import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AgentInputMessage, TraceDelivery } from "@ailoha/agent-core";
import { AgentServiceRuntime } from "./agent-service-runtime.js";
import { AgentServiceError, mapServiceError, serviceFailure } from "./errors.js";
import type { AgentServiceHttpOptions, MessageDelivery, ServiceEventRecord, ServiceRequestContext } from "./types.js";

function json(response: ServerResponse, status: number, value?: unknown): void {
	if (value === undefined) {
		response.writeHead(status).end();
		return;
	}
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

function header(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBytes) throw serviceFailure("invalid_request", "The request body is too large.", 413);
		chunks.push(buffer);
	}
	if (size === 0) return {};
	try {
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Body must be an object.");
		return value as Record<string, unknown>;
	} catch (cause) {
		throw serviceFailure("invalid_request", "The request body must be valid JSON.", 400, false, undefined);
	}
}

function idempotencyKey(request: IncomingMessage): string {
	const value = header(request, "idempotency-key");
	if (!value) throw serviceFailure("invalid_request", "Idempotency-Key is required.", 400);
	return value;
}

function text(value: unknown, name: string, required = true): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || (required && value.trim() === "")) {
		throw serviceFailure("invalid_request", `${name} must be a string.`, 400);
	}
	return value;
}

function writeSse(response: ServerResponse, cursor: string, event: string, data: unknown): void {
	response.write(`id: ${cursor}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamEvents(
	request: IncomingMessage,
	response: ServerResponse,
	iterable: AsyncIterable<ServiceEventRecord>,
): Promise<void> {
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
	});
	response.flushHeaders();
	const iterator = iterable[Symbol.asyncIterator]();
	const close = () => void iterator.return?.();
	response.on("close", close);
	try {
		while (!response.destroyed) {
			const item = await iterator.next();
			if (item.done) break;
			writeSse(response, item.value.cursor, item.value.event.type, item.value.event);
		}
	} finally {
		response.off("close", close);
		await iterator.return?.();
		if (!response.destroyed) response.end();
	}
}

async function streamTrace(response: ServerResponse, iterable: AsyncIterable<TraceDelivery>): Promise<void> {
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
	});
	response.flushHeaders();
	const iterator = iterable[Symbol.asyncIterator]();
	const close = () => void iterator.return?.();
	response.on("close", close);
	try {
		while (!response.destroyed) {
			const item = await iterator.next();
			if (item.done) break;
			if (item.value.kind === "event") writeSse(response, item.value.cursor, item.value.event.type, item.value.event);
			else response.write(`event: trace.gap\ndata: ${JSON.stringify(item.value)}\n\n`);
		}
	} finally {
		response.off("close", close);
		await iterator.return?.();
		if (!response.destroyed) response.end();
	}
}

async function streamRunTrace(response: ServerResponse, path: string): Promise<void> {
	response.writeHead(200, {
		"content-type": "application/x-ndjson; charset=utf-8",
		"cache-control": "private, no-store",
	});
	await pipeline(createReadStream(path), response);
}

export function createAgentServiceHttpHandler(runtime: AgentServiceRuntime, options: AgentServiceHttpOptions) {
	const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
	if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError("maxBodyBytes must be positive.");

	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		try {
			let context: ServiceRequestContext;
			try {
				context = await options.authenticate(request);
			} catch (cause) {
				if (cause instanceof AgentServiceError) throw cause;
				throw serviceFailure("unauthenticated", "Authentication is required.", 401);
			}
			if (!context?.ownerId) throw serviceFailure("unauthenticated", "Authentication is required.", 401);
			const url = new URL(request.url ?? "/", "http://localhost");
			const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			if (parts[0] !== "v1") throw serviceFailure("not_found", "Route was not found.", 404);
			const method = request.method ?? "GET";

			if (parts[1] === "agent-profiles") {
				await handleProfiles(runtime, request, response, method, parts, maxBodyBytes);
				return;
			}
			if (parts[1] === "sessions") {
				await handleSessions(runtime, request, response, method, parts, url, context, maxBodyBytes);
				return;
			}
			if (parts[1] === "runs") {
				await handleRuns(runtime, request, response, method, parts, context, maxBodyBytes);
				return;
			}
			if (parts[1] === "operations" && method === "GET" && parts.length === 3) {
				const operation = await runtime.getOperation(parts[2], context);
				if (!operation) throw serviceFailure("not_found", "Operation was not found.", 404);
				json(response, 200, operation);
				return;
			}
			throw serviceFailure("not_found", "Route was not found.", 404);
		} catch (cause) {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			const error = cause instanceof AgentServiceError ? cause : mapServiceError(cause);
			json(response, error.httpStatus, { error: error.serviceError });
		}
	};
}

async function handleProfiles(
	runtime: AgentServiceRuntime,
	request: IncomingMessage,
	response: ServerResponse,
	method: string,
	parts: string[],
	maxBodyBytes: number,
): Promise<void> {
	if (parts.length === 2 && method === "GET") {
		json(response, 200, { items: await runtime.listAgentProfiles() });
		return;
	}
	if (parts.length === 2 && method === "POST") {
		const body = await readJson(request, maxBodyBytes);
		json(response, 201, await runtime.createAgentProfile(body as never));
		return;
	}
	if (parts.length === 3 && method === "GET") {
		const profile = await runtime.getAgentProfile(parts[2]);
		if (!profile) throw serviceFailure("not_found", "Agent Profile was not found.", 404);
		json(response, 200, profile);
		return;
	}
	if (parts.length === 3 && method === "PATCH") {
		json(response, 200, await runtime.updateAgentProfile(parts[2], (await readJson(request, maxBodyBytes)) as never));
		return;
	}
	if (parts.length === 3 && method === "DELETE") {
		if (!(await runtime.deleteAgentProfile(parts[2]))) throw serviceFailure("not_found", "Agent Profile was not found.", 404);
		json(response, 204);
		return;
	}
	throw serviceFailure("not_found", "Route was not found.", 404);
}

async function handleSessions(
	runtime: AgentServiceRuntime,
	request: IncomingMessage,
	response: ServerResponse,
	method: string,
	parts: string[],
	url: URL,
	context: ServiceRequestContext,
	maxBodyBytes: number,
): Promise<void> {
	if (parts.length === 2 && method === "GET") {
		json(response, 200, { items: await runtime.listSessions(context) });
		return;
	}
	if (parts.length === 2 && method === "POST") {
		const body = await readJson(request, maxBodyBytes);
		json(
			response,
			201,
			await runtime.createSession(
				{
					agentProfileId: text(body.agentProfileId, "agentProfileId")!,
					...(body.title === undefined ? {} : { title: text(body.title, "title", false) }),
					idempotencyKey: idempotencyKey(request),
				},
				context,
			),
		);
		return;
	}
	if (parts.length < 3) throw serviceFailure("not_found", "Route was not found.", 404);
	const sessionId = parts[2];
	if (parts.length === 3 && method === "GET") {
		const session = await runtime.getSession(sessionId, context);
		if (!session) throw serviceFailure("not_found", "Session was not found.", 404);
		json(response, 200, session);
		return;
	}
	if (parts.length === 3 && method === "PATCH") {
		const body = await readJson(request, maxBodyBytes);
		json(response, 200, await runtime.updateSession(sessionId, { title: text(body.title, "title", false) }, context));
		return;
	}
	if (parts.length === 3 && method === "DELETE") {
		await runtime.closeSession(sessionId, idempotencyKey(request), context);
		json(response, 204);
		return;
	}
	if (parts.length === 4 && parts[3] === "messages" && method === "POST") {
		const body = await readJson(request, maxBodyBytes);
		const delivery = body.delivery ?? "auto";
		if (!["auto", "prompt", "steer", "follow_up"].includes(String(delivery))) {
			throw serviceFailure("invalid_request", "delivery is invalid.", 400);
		}
		const input: AgentInputMessage = { role: "user", content: body.content as never, timestamp: Date.now() };
		json(
			response,
			202,
			await runtime.sendMessage(
				{ sessionId, message: input, delivery: delivery as MessageDelivery, idempotencyKey: idempotencyKey(request) },
				context,
			),
		);
		return;
	}
	if (parts.length === 4 && parts[3] === "messages" && method === "GET") {
		json(response, 200, await runtime.listMessages(sessionId, url.searchParams.get("cursor") ?? undefined, context));
		return;
	}
	if (parts.length === 4 && parts[3] === "compact" && method === "POST") {
		await readJson(request, maxBodyBytes);
		json(
			response,
			202,
			await runtime.compactSession({ sessionId, idempotencyKey: idempotencyKey(request) }, context),
		);
		return;
	}
	if (parts.length === 4 && parts[3] === "events" && method === "GET") {
		const cursor = header(request, "last-event-id") ?? url.searchParams.get("cursor") ?? undefined;
		await streamEvents(request, response, runtime.subscribeSessionEvents(sessionId, cursor, context));
		return;
	}
	if (parts.length === 4 && parts[3] === "trace" && method === "GET") {
		const cursor = header(request, "last-event-id") ?? url.searchParams.get("cursor") ?? undefined;
		await streamTrace(response, runtime.subscribeSessionTrace(sessionId, cursor, context));
		return;
	}
	throw serviceFailure("not_found", "Route was not found.", 404);
}

async function handleRuns(
	runtime: AgentServiceRuntime,
	request: IncomingMessage,
	response: ServerResponse,
	method: string,
	parts: string[],
	context: ServiceRequestContext,
	maxBodyBytes: number,
): Promise<void> {
	if (parts.length < 3) throw serviceFailure("not_found", "Route was not found.", 404);
	const runId = parts[2];
	const run = await runtime.getRun(runId, context);
	if (!run) throw serviceFailure("not_found", "Run was not found.", 404);
	if (parts.length === 3 && method === "GET") {
		json(response, 200, run);
		return;
	}
	if (parts.length === 4 && parts[3] === "trace" && method === "GET") {
		await streamRunTrace(response, await runtime.getRunTracePath(runId, context));
		return;
	}
	if (parts.length === 4 && parts[3] === "abort" && method === "POST") {
		await readJson(request, maxBodyBytes);
		json(response, 202, await runtime.abortRun(run.sessionId, runId, idempotencyKey(request), context));
		return;
	}
	if (parts.length === 4 && (parts[3] === "steer" || parts[3] === "follow-ups") && method === "POST") {
		const body = await readJson(request, maxBodyBytes);
		json(
			response,
			202,
			await runtime.sendRunMessage(
				{
					runId,
					message: { role: "user", content: body.content as never, timestamp: Date.now() },
					delivery: parts[3] === "steer" ? "steer" : "follow_up",
					idempotencyKey: idempotencyKey(request),
				},
				context,
			),
		);
		return;
	}
	throw serviceFailure("not_found", "Route was not found.", 404);
}

export function createAgentServiceHttpServer(
	runtime: AgentServiceRuntime,
	options: AgentServiceHttpOptions,
): Server {
	const handler = createAgentServiceHttpHandler(runtime, options);
	return createServer((request, response) => {
		void handler(request, response);
	});
}
