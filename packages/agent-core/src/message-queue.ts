import type { AgentInputMessage } from "./types.js";

export class MessageQueue {
	readonly #messages: AgentInputMessage[] = [];

	enqueue(message: AgentInputMessage): void {
		this.#messages.push(message);
	}

	drain(): AgentInputMessage[] {
		return this.#messages.splice(0, this.#messages.length);
	}

	clear(): void {
		this.#messages.length = 0;
	}

	get size(): number {
		return this.#messages.length;
	}
}
