import { describe, expect, it } from "vitest";
import { InMemoryServiceEventPublisher } from "../src/index.js";
import type { ServiceEvent } from "../src/index.js";

function event(id: string, sessionId = "session-a"): ServiceEvent {
	return {
		id,
		type: "message.accepted",
		timeUnixMs: 1,
		ownerId: "owner-a",
		sessionId,
	};
}

describe("InMemoryServiceEventPublisher", () => {
	it("replays strictly after a cursor, filters by Session, then continues live", async () => {
		const publisher = new InMemoryServiceEventPublisher();
		const first = publisher.publish(event("one"));
		publisher.publish(event("other", "session-b"));
		publisher.publish(event("two"));
		const subscription = publisher.subscribe("session-a", first.cursor);
		const iterator = subscription[Symbol.asyncIterator]();
		expect((await iterator.next()).value?.event.id).toBe("two");
		publisher.publish(event("three"));
		expect((await iterator.next()).value?.event.id).toBe("three");
		subscription.close();
		publisher.dispose();
	});

	it("rejects expired cursors without leaking another replay window", () => {
		const publisher = new InMemoryServiceEventPublisher({ replayCapacity: 1 });
		const expired = publisher.publish(event("one"));
		publisher.publish(event("two"));
		expect(() => publisher.subscribe("session-a", expired.cursor)).toThrowError(
			expect.objectContaining({ serviceError: expect.objectContaining({ code: "cursor_expired" }) }),
		);
		publisher.dispose();
	});
});
