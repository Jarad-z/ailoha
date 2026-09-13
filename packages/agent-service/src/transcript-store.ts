import { serviceFailure } from "./errors.js";
import type { MessagePage, ServiceMessage, TranscriptStore } from "./types.js";

export class InMemoryTranscriptStore implements TranscriptStore {
	readonly #messages = new Map<string, ServiceMessage[]>();
	readonly #pageSize: number;

	constructor(options: { readonly pageSize?: number } = {}) {
		this.#pageSize = options.pageSize ?? 100;
		if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1) throw new RangeError("pageSize must be positive.");
	}

	append(message: ServiceMessage): void {
		const list = this.#messages.get(message.sessionId) ?? [];
		list.push(message);
		this.#messages.set(message.sessionId, list);
	}

	list(sessionId: string, cursor?: string): MessagePage {
		const messages = this.#messages.get(sessionId) ?? [];
		let offset = 0;
		if (cursor !== undefined) {
			const prefix = `msg.${sessionId}.`;
			const encoded = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : "";
			offset = Number.parseInt(encoded, 36);
			if (!/^[0-9a-z]+$/.test(encoded) || !Number.isSafeInteger(offset) || offset < 0 || offset > messages.length) {
				throw serviceFailure("invalid_cursor", "The message cursor is invalid.", 400);
			}
		}
		const items = Object.freeze(messages.slice(offset, offset + this.#pageSize));
		const nextOffset = offset + items.length;
		return Object.freeze({
			items,
			...(nextOffset < messages.length ? { nextCursor: `msg.${sessionId}.${nextOffset.toString(36)}` } : {}),
		});
	}
}
