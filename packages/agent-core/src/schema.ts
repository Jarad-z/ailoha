import type { AgentToolSchema } from "./types.js";

export interface SchemaValidationResult {
	readonly valid: boolean;
	readonly error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function validateJsonSchema(schema: AgentToolSchema, value: unknown, path = "arguments"): SchemaValidationResult {
	const definition = schema as Record<string, unknown>;
	if (Array.isArray(definition.anyOf)) {
		const matched = definition.anyOf.some(
			(candidate) => asRecord(candidate) && validateJsonSchema(candidate as AgentToolSchema, value, path).valid,
		);
		if (!matched) return { valid: false, error: `${path} does not match any allowed schema.` };
	}
	if (Array.isArray(definition.oneOf)) {
		const matches = definition.oneOf.filter(
			(candidate) => asRecord(candidate) && validateJsonSchema(candidate as AgentToolSchema, value, path).valid,
		).length;
		if (matches !== 1) return { valid: false, error: `${path} must match exactly one allowed schema.` };
	}
	if (Array.isArray(definition.allOf)) {
		for (const candidate of definition.allOf) {
			if (!asRecord(candidate)) continue;
			const result = validateJsonSchema(candidate as AgentToolSchema, value, path);
			if (!result.valid) return result;
		}
	}
	if (Object.hasOwn(definition, "const") && !Object.is(value, definition.const)) {
		return { valid: false, error: `${path} must equal the schema const value.` };
	}
	if (Array.isArray(definition.enum) && !definition.enum.some((item) => Object.is(item, value))) {
		return { valid: false, error: `${path} must be one of the allowed values.` };
	}

	if (typeof definition.type === "string") {
		const matches =
			definition.type === "null"
				? value === null
				: definition.type === "array"
					? Array.isArray(value)
					: definition.type === "object"
						? asRecord(value) !== undefined
						: definition.type === "integer"
							? typeof value === "number" && Number.isInteger(value)
							: typeof value === definition.type;
		if (!matches) return { valid: false, error: `${path} must be of type ${definition.type}.` };
	}
	if (typeof value === "string") {
		if (typeof definition.minLength === "number" && value.length < definition.minLength) {
			return { valid: false, error: `${path} must contain at least ${definition.minLength} characters.` };
		}
		if (typeof definition.maxLength === "number" && value.length > definition.maxLength) {
			return { valid: false, error: `${path} must contain at most ${definition.maxLength} characters.` };
		}
		if (typeof definition.pattern === "string" && !new RegExp(definition.pattern, "u").test(value)) {
			return { valid: false, error: `${path} must match the required pattern.` };
		}
	}
	if (typeof value === "number") {
		if (typeof definition.minimum === "number" && value < definition.minimum) {
			return { valid: false, error: `${path} must be at least ${definition.minimum}.` };
		}
		if (typeof definition.maximum === "number" && value > definition.maximum) {
			return { valid: false, error: `${path} must be at most ${definition.maximum}.` };
		}
	}

	if (Array.isArray(value) && asRecord(definition.items)) {
		if (typeof definition.minItems === "number" && value.length < definition.minItems) {
			return { valid: false, error: `${path} must contain at least ${definition.minItems} items.` };
		}
		if (typeof definition.maxItems === "number" && value.length > definition.maxItems) {
			return { valid: false, error: `${path} must contain at most ${definition.maxItems} items.` };
		}
		for (let index = 0; index < value.length; index++) {
			const result = validateJsonSchema(definition.items as AgentToolSchema, value[index], `${path}[${index}]`);
			if (!result.valid) return result;
		}
	}

	const record = asRecord(value);
	if (!record) return { valid: true };
	const properties = asRecord(definition.properties) ?? {};
	const required = Array.isArray(definition.required)
		? definition.required.filter((item): item is string => typeof item === "string")
		: [];
	for (const key of required) {
		if (!Object.hasOwn(record, key)) return { valid: false, error: `${path}.${key} is required.` };
	}
	for (const [key, child] of Object.entries(properties)) {
		if (!Object.hasOwn(record, key) || !asRecord(child)) continue;
		const result = validateJsonSchema(child as AgentToolSchema, record[key], `${path}.${key}`);
		if (!result.valid) return result;
	}
	if (definition.additionalProperties === false) {
		const allowed = new Set(Object.keys(properties));
		const extra = Object.keys(record).find((key) => !allowed.has(key));
		if (extra) return { valid: false, error: `${path}.${extra} is not allowed.` };
	}
	return { valid: true };
}
