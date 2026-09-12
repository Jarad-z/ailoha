import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@ailoha/agent-core";

export interface SearchDocument {
	readonly id: string;
	readonly title: string;
	readonly content: string;
	readonly url?: string;
}

export interface SearchResult {
	readonly id: string;
	readonly title: string;
	readonly snippet: string;
	readonly url?: string;
	readonly score?: number;
}

export type SearchProvider = (
	query: string,
	options: { readonly limit: number; readonly signal: AbortSignal },
) => readonly SearchResult[] | Promise<readonly SearchResult[]>;

export interface SearchToolOptions {
	readonly provider?: SearchProvider;
	readonly documents?: readonly SearchDocument[];
	readonly defaultLimit?: number;
	readonly maxLimit?: number;
}

function terms(value: string): string[] {
	return value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

export function createMockSearchProvider(documents: readonly SearchDocument[]): SearchProvider {
	const index = [...documents];
	return (query, options) => {
		const queryTerms = terms(query);
		return index
			.map((document) => {
				const title = document.title.toLowerCase();
				const content = document.content.toLowerCase();
				const score = queryTerms.reduce(
					(total, term) => total + (title.includes(term) ? 3 : 0) + (content.includes(term) ? 1 : 0),
					0,
				);
				const firstMatch = queryTerms.map((term) => content.indexOf(term)).find((offset) => offset >= 0) ?? 0;
				const start = Math.max(0, firstMatch - 60);
				return {
					id: document.id,
					title: document.title,
					snippet: document.content.slice(start, start + 240),
					url: document.url,
					score,
				};
			})
			.filter((result) => queryTerms.length === 0 || result.score > 0)
			.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
			.slice(0, options.limit);
	};
}

export function createSearchTool(options: SearchToolOptions = {}): AgentTool {
	const defaultLimit = Math.max(1, Math.floor(options.defaultLimit ?? 5));
	const maxLimit = Math.max(defaultLimit, Math.floor(options.maxLimit ?? 20));
	const provider = options.provider ?? createMockSearchProvider(options.documents ?? []);
	return {
		name: "search",
		description: "Search configured sources and return ranked results with snippets.",
		parameters: Type.Object(
			{
				query: Type.String({ minLength: 1 }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxLimit })),
			},
			{ additionalProperties: false },
		),
		async execute(toolCall, context) {
			const query = String(toolCall.arguments.query).trim();
			const requested = typeof toolCall.arguments.limit === "number" ? toolCall.arguments.limit : defaultLimit;
			const limit = Math.min(maxLimit, Math.max(1, Math.floor(requested)));
			const results = await provider(query, { limit, signal: context.signal });
			context.signal.throwIfAborted();
			return { content: JSON.stringify({ query, results }) };
		},
	};
}
