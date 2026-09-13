import { randomUUID } from "node:crypto";
import { serviceFailure } from "./errors.js";
import type { ServiceEvent, ServiceEventPublisher, ServiceEventRecord, ServiceEventSubscription } from "./types.js";

interface PendingNext {
	readonly resolve: (value: IteratorResult<ServiceEventRecord>) => void;
}

class Subscription implements ServiceEventSubscription, AsyncIterator<ServiceEventRecord> {
	readonly #sessionId: string;
	readonly #capacity: number;
	readonly #onClose: (subscription: Subscription) => void;
	readonly #buffer: ServiceEventRecord[] = [];
	readonly #pending: PendingNext[] = [];
	#closed = false;

	constructor(sessionId: string, capacity: number, onClose: (subscription: Subscription) => void) {
		this.#sessionId = sessionId;
		this.#capacity = capacity;
		this.#onClose = onClose;
	}

	[Symbol.asyncIterator](): AsyncIterator<ServiceEventRecord> {
		return this;
	}

	next(): Promise<IteratorResult<ServiceEventRecord>> {
		const value = this.#buffer.shift();
		if (value) return Promise.resolve({ done: false, value });
		if (this.#closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => this.#pending.push({ resolve }));
	}

	return(): Promise<IteratorResult<ServiceEventRecord>> {
		this.close("iterator_return");
		return Promise.resolve({ done: true, value: undefined });
	}

	accept(record: ServiceEventRecord): void {
		if (this.#closed || record.event.sessionId !== this.#sessionId) return;
		const pending = this.#pending.shift();
		if (pending) {
			pending.resolve({ done: false, value: record });
			return;
		}
		if (this.#buffer.length >= this.#capacity) {
			this.close("subscriber_overflow");
			return;
		}
		this.#buffer.push(record);
	}

	close(_reason?: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffer.splice(0);
		for (const pending of this.#pending.splice(0)) pending.resolve({ done: true, value: undefined });
		this.#onClose(this);
	}
}

export class InMemoryServiceEventPublisher implements ServiceEventPublisher {
	readonly #capacity: number;
	readonly #subscriberCapacity: number;
	readonly #hubId = randomUUID();
	readonly #records: ServiceEventRecord[] = [];
	readonly #subscriptions = new Set<Subscription>();
	#offset = 0;
	#disposed = false;

	constructor(options: { readonly replayCapacity?: number; readonly subscriberCapacity?: number } = {}) {
		this.#capacity = options.replayCapacity ?? 10_000;
		this.#subscriberCapacity = options.subscriberCapacity ?? 1_000;
		if (!Number.isInteger(this.#capacity) || this.#capacity < 0) throw new RangeError("replayCapacity is invalid.");
		if (!Number.isInteger(this.#subscriberCapacity) || this.#subscriberCapacity < 1) {
			throw new RangeError("subscriberCapacity is invalid.");
		}
	}

	publish(event: ServiceEvent): ServiceEventRecord {
		if (this.#disposed) throw serviceFailure("runtime_unavailable", "The event publisher is disposed.", 503, true);
		this.#offset++;
		const record = Object.freeze({ cursor: `evt.${this.#hubId}.${this.#offset.toString(36)}`, event });
		if (this.#capacity > 0) {
			this.#records.push(record);
			if (this.#records.length > this.#capacity) this.#records.shift();
		}
		for (const subscription of [...this.#subscriptions]) subscription.accept(record);
		return record;
	}

	subscribe(sessionId: string, cursor?: string): ServiceEventSubscription {
		if (this.#disposed) throw serviceFailure("runtime_unavailable", "The event publisher is disposed.", 503, true);
		const subscription = new Subscription(sessionId, this.#subscriberCapacity, (value) => this.#subscriptions.delete(value));
		const replay = cursor === undefined ? [] : this.#replayAfter(cursor);
		for (const record of replay) subscription.accept(record);
		this.#subscriptions.add(subscription);
		return subscription;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const subscription of [...this.#subscriptions]) subscription.close("publisher_disposed");
		this.#records.splice(0);
	}

	#replayAfter(cursor: string): readonly ServiceEventRecord[] {
		const prefix = `evt.${this.#hubId}.`;
		if (!cursor.startsWith(prefix)) throw serviceFailure("invalid_cursor", "The event cursor is invalid.", 400);
		const encoded = cursor.slice(prefix.length);
		const offset = Number.parseInt(encoded, 36);
		if (!/^[0-9a-z]+$/.test(encoded) || !Number.isSafeInteger(offset) || offset < 1 || offset > this.#offset) {
			throw serviceFailure("invalid_cursor", "The event cursor is invalid.", 400);
		}
		if (offset === this.#offset) return [];
		const earliest = this.#records[0];
		if (!earliest) throw serviceFailure("cursor_expired", "The event cursor has expired.", 409);
		const index = this.#records.findIndex((record) => record.cursor === cursor);
		if (index < 0) throw serviceFailure("cursor_expired", "The event cursor has expired.", 409);
		return this.#records.slice(index + 1);
	}
}
