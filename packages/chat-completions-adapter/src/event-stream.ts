import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AssistantEventStream } from "./types.js";

interface PendingRead {
	readonly resolve: (value: IteratorResult<AssistantMessageEvent>) => void;
}

export class AssistantEventStreamImpl implements AssistantEventStream {
	readonly #queue: AssistantMessageEvent[] = [];
	readonly #readers: PendingRead[] = [];
	readonly #resultPromise: Promise<AssistantMessage>;
	#resolveResult!: (message: AssistantMessage) => void;
	#terminalMessage?: AssistantMessage;

	constructor() {
		this.#resultPromise = new Promise<AssistantMessage>((resolve) => {
			this.#resolveResult = resolve;
		});
	}

	push(event: AssistantMessageEvent): void {
		if (this.#terminalMessage) return;
		if (event.type === "done" || event.type === "error") {
			this.#terminalMessage = event.type === "done" ? event.message : event.error;
			this.#resolveResult(this.#terminalMessage);
		}
		const reader = this.#readers.shift();
		if (reader) reader.resolve({ done: false, value: event });
		else this.#queue.push(event);
	}

	end(message: AssistantMessage): void {
		if (!this.#terminalMessage) throw new Error("Cannot end an event stream without a terminal event.");
		if (this.#terminalMessage !== message) throw new Error("Terminal message identity mismatch.");
		this.#finishReadersIfDrained();
	}

	result(): Promise<AssistantMessage> {
		return this.#resultPromise;
	}

	[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return {
			next: async () => {
				const event = this.#queue.shift();
				if (event) return { done: false, value: event };
				if (this.#terminalMessage) return { done: true, value: undefined };
				return await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
					this.#readers.push({ resolve });
				});
			},
		};
	}

	#finishReadersIfDrained(): void {
		if (!this.#terminalMessage || this.#queue.length > 0) return;
		for (const reader of this.#readers.splice(0)) reader.resolve({ done: true, value: undefined });
	}
}
