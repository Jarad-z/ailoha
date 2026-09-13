import { randomUUID } from "node:crypto";
import { serviceFailure } from "./errors.js";
import type {
	AgentProfile,
	AgentProfileRegistry,
	CreateAgentProfileInput,
	UpdateAgentProfileInput,
} from "./types.js";

function freezeProfile(profile: AgentProfile): AgentProfile {
	return Object.freeze({
		...profile,
		systemPrompts: Object.freeze([...profile.systemPrompts]),
		tools: Object.freeze(profile.tools.map((tool) => Object.freeze({ ...tool }))),
	});
}

function validate(input: CreateAgentProfileInput | UpdateAgentProfileInput): void {
	if ("name" in input && input.name !== undefined && input.name.trim() === "") {
		throw serviceFailure("invalid_request", "Profile name must not be empty.", 400);
	}
	if ("modelId" in input && input.modelId !== undefined && input.modelId.trim() === "") {
		throw serviceFailure("invalid_request", "Profile modelId must not be empty.", 400);
	}
	if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 0)) {
		throw serviceFailure("invalid_request", "maxTurns must be a non-negative integer.", 400);
	}
}

export class InMemoryAgentProfileRegistry implements AgentProfileRegistry {
	readonly #profiles = new Map<string, AgentProfile>();
	readonly #clock: () => number;
	readonly #generateId: () => string;

	constructor(options: { readonly clock?: () => number; readonly generateId?: () => string } = {}) {
		this.#clock = options.clock ?? Date.now;
		this.#generateId = options.generateId ?? (() => `profile_${randomUUID()}`);
	}

	async create(input: CreateAgentProfileInput): Promise<AgentProfile> {
		validate(input);
		if (typeof input.name !== "string" || input.name.trim() === "") {
			throw serviceFailure("invalid_request", "Profile name must not be empty.", 400);
		}
		if (typeof input.modelId !== "string" || input.modelId.trim() === "") {
			throw serviceFailure("invalid_request", "Profile modelId must not be empty.", 400);
		}
		const id = input.id ?? this.#generateId();
		if (this.#profiles.has(id)) throw serviceFailure("profile_already_exists", "Agent Profile already exists.", 409);
		const now = this.#clock();
		const profile = freezeProfile({
			id,
			name: input.name,
			modelId: input.modelId,
			systemPrompts: input.systemPrompts ?? [],
			tools: input.tools ?? [],
			...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
			createdAt: now,
			updatedAt: now,
		});
		this.#profiles.set(id, profile);
		return profile;
	}

	async get(id: string): Promise<AgentProfile | undefined> {
		return this.#profiles.get(id);
	}

	async list(): Promise<readonly AgentProfile[]> {
		return Object.freeze([...this.#profiles.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
	}

	async update(id: string, patch: UpdateAgentProfileInput): Promise<AgentProfile> {
		validate(patch);
		const current = this.#profiles.get(id);
		if (!current) throw serviceFailure("not_found", "Agent Profile was not found.", 404);
		const profile = freezeProfile({ ...current, ...patch, id, createdAt: current.createdAt, updatedAt: this.#clock() });
		this.#profiles.set(id, profile);
		return profile;
	}

	async delete(id: string): Promise<boolean> {
		return this.#profiles.delete(id);
	}
}
