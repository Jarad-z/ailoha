import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@ailoha/agent-core";

export type TodoStatus = "pending" | "completed";

export interface TodoItem {
	readonly id: string;
	readonly text: string;
	readonly status: TodoStatus;
}

export interface TodoStore {
	list(): readonly TodoItem[] | Promise<readonly TodoItem[]>;
	add(text: string): TodoItem | Promise<TodoItem>;
	complete(id: string): TodoItem | undefined | Promise<TodoItem | undefined>;
	remove(id: string): boolean | Promise<boolean>;
	clear(): number | Promise<number>;
}

export interface TodoToolOptions {
	readonly store?: TodoStore;
	readonly initialItems?: readonly string[];
}

export class InMemoryTodoStore implements TodoStore {
	readonly #items = new Map<string, TodoItem>();
	#nextId = 1;

	constructor(initialItems: readonly string[] = []) {
		for (const text of initialItems) this.add(text);
	}

	list(): readonly TodoItem[] {
		return [...this.#items.values()];
	}

	add(text: string): TodoItem {
		const item: TodoItem = { id: `todo-${this.#nextId++}`, text, status: "pending" };
		this.#items.set(item.id, item);
		return item;
	}

	complete(id: string): TodoItem | undefined {
		const current = this.#items.get(id);
		if (!current) return undefined;
		const completed: TodoItem = { ...current, status: "completed" };
		this.#items.set(id, completed);
		return completed;
	}

	remove(id: string): boolean {
		return this.#items.delete(id);
	}

	clear(): number {
		const count = this.#items.size;
		this.#items.clear();
		return count;
	}
}

export function createTodoTool(options: TodoToolOptions = {}): AgentTool {
	const store = options.store ?? new InMemoryTodoStore(options.initialItems);
	return {
		name: "todo",
		description: "Manage a todo list. Actions: list, add, complete, remove, and clear.",
		parameters: Type.Object(
			{
				action: Type.Union([
					Type.Literal("list"),
					Type.Literal("add"),
					Type.Literal("complete"),
					Type.Literal("remove"),
					Type.Literal("clear"),
				]),
				text: Type.Optional(Type.String({ minLength: 1 })),
				id: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		async execute(toolCall, context) {
			const action = toolCall.arguments.action;
			context.signal.throwIfAborted();
			if (action === "list") return { content: JSON.stringify({ items: await store.list() }) };
			if (action === "add") {
				const text = typeof toolCall.arguments.text === "string" ? toolCall.arguments.text.trim() : "";
				if (!text) return { content: 'todo action "add" requires non-empty text.', isError: true };
				return { content: JSON.stringify({ item: await store.add(text) }) };
			}
			if (action === "complete") {
				const id = typeof toolCall.arguments.id === "string" ? toolCall.arguments.id : "";
				if (!id) return { content: 'todo action "complete" requires id.', isError: true };
				const item = await store.complete(id);
				return item
					? { content: JSON.stringify({ item }) }
					: { content: `Todo item not found: ${id}`, isError: true };
			}
			if (action === "remove") {
				const id = typeof toolCall.arguments.id === "string" ? toolCall.arguments.id : "";
				if (!id) return { content: 'todo action "remove" requires id.', isError: true };
				const removed = await store.remove(id);
				return removed
					? { content: JSON.stringify({ removed: id }) }
					: { content: `Todo item not found: ${id}`, isError: true };
			}
			if (action === "clear") return { content: JSON.stringify({ cleared: await store.clear() }) };
			return { content: `Unknown todo action: ${String(action)}`, isError: true };
		},
	};
}
