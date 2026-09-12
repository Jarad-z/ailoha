import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@ailoha/agent-core";

type TokenType = "number" | "identifier" | "operator" | "left" | "right" | "comma" | "end";

interface Token {
	readonly type: TokenType;
	readonly text: string;
	readonly number?: number;
}

const FUNCTIONS: Readonly<Record<string, (...values: number[]) => number>> = {
	abs: (value) => Math.abs(value),
	ceil: (value) => Math.ceil(value),
	cos: (value) => Math.cos(value),
	exp: (value) => Math.exp(value),
	floor: (value) => Math.floor(value),
	ln: (value) => Math.log(value),
	log: (value) => Math.log10(value),
	max: (...values) => Math.max(...values),
	min: (...values) => Math.min(...values),
	round: (value) => Math.round(value),
	sin: (value) => Math.sin(value),
	sqrt: (value) => Math.sqrt(value),
	tan: (value) => Math.tan(value),
};

const FIXED_ARITY: Readonly<Record<string, number>> = {
	abs: 1,
	ceil: 1,
	cos: 1,
	exp: 1,
	floor: 1,
	ln: 1,
	log: 1,
	round: 1,
	sin: 1,
	sqrt: 1,
	tan: 1,
};

function tokenize(expression: string): Token[] {
	const tokens: Token[] = [];
	let offset = 0;
	while (offset < expression.length) {
		const rest = expression.slice(offset);
		const whitespace = /^\s+/.exec(rest);
		if (whitespace) {
			offset += whitespace[0].length;
			continue;
		}
		const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
		if (number) {
			const value = Number(number[0]);
			if (!Number.isFinite(value)) throw new Error(`Invalid number at position ${offset}.`);
			tokens.push({ type: "number", text: number[0], number: value });
			offset += number[0].length;
			continue;
		}
		const identifier = /^[a-z_][a-z0-9_]*/i.exec(rest);
		if (identifier) {
			tokens.push({ type: "identifier", text: identifier[0].toLowerCase() });
			offset += identifier[0].length;
			continue;
		}
		const character = expression[offset];
		if ("+-*/%^".includes(character)) tokens.push({ type: "operator", text: character });
		else if (character === "(") tokens.push({ type: "left", text: character });
		else if (character === ")") tokens.push({ type: "right", text: character });
		else if (character === ",") tokens.push({ type: "comma", text: character });
		else throw new Error(`Unexpected character "${character}" at position ${offset}.`);
		offset++;
	}
	tokens.push({ type: "end", text: "" });
	return tokens;
}

class ExpressionParser {
	readonly #tokens: readonly Token[];
	#index = 0;

	constructor(expression: string) {
		this.#tokens = tokenize(expression);
	}

	parse(): number {
		const value = this.#parseAdditive();
		if (this.#current().type !== "end") throw new Error(`Unexpected token "${this.#current().text}".`);
		return this.#finite(value);
	}

	#parseAdditive(): number {
		let value = this.#parseMultiplicative();
		while (this.#matchOperator("+") || this.#matchOperator("-")) {
			const operator = this.#previous().text;
			const right = this.#parseMultiplicative();
			value = operator === "+" ? value + right : value - right;
		}
		return this.#finite(value);
	}

	#parseMultiplicative(): number {
		let value = this.#parseUnary();
		while (this.#matchOperator("*") || this.#matchOperator("/") || this.#matchOperator("%")) {
			const operator = this.#previous().text;
			const right = this.#parseUnary();
			if ((operator === "/" || operator === "%") && right === 0) throw new Error("Division by zero.");
			if (operator === "*") value *= right;
			else if (operator === "/") value /= right;
			else value %= right;
		}
		return this.#finite(value);
	}

	#parseUnary(): number {
		if (this.#matchOperator("+")) return this.#parseUnary();
		if (this.#matchOperator("-")) return -this.#parseUnary();
		return this.#parsePower();
	}

	#parsePower(): number {
		const left = this.#parsePrimary();
		if (!this.#matchOperator("^")) return left;
		return this.#finite(left ** this.#parseUnary());
	}

	#parsePrimary(): number {
		if (this.#current().type === "number") return this.#advance().number ?? 0;
		if (this.#current().type === "identifier") {
			const name = this.#advance().text;
			if (name === "pi") return Math.PI;
			if (name === "e") return Math.E;
			if (this.#current().type !== "left") throw new Error(`Unknown constant "${name}".`);
			this.#advance();
			const values: number[] = [];
			if (this.#current().type !== "right") {
				do values.push(this.#parseAdditive());
				while (this.#match("comma"));
			}
			this.#expect("right", `Expected ")" after ${name} arguments.`);
			const operation = FUNCTIONS[name];
			if (!operation) throw new Error(`Unknown function "${name}".`);
			const arity = FIXED_ARITY[name];
			if ((arity !== undefined && values.length !== arity) || (arity === undefined && values.length === 0)) {
				throw new Error(`Invalid argument count for ${name}.`);
			}
			return this.#finite(operation(...values));
		}
		if (this.#match("left")) {
			const value = this.#parseAdditive();
			this.#expect("right", 'Expected ")".');
			return value;
		}
		throw new Error(`Expected a number, constant, function, or "("; received "${this.#current().text}".`);
	}

	#match(type: TokenType): boolean {
		if (this.#current().type !== type) return false;
		this.#advance();
		return true;
	}

	#matchOperator(operator: string): boolean {
		if (this.#current().type !== "operator" || this.#current().text !== operator) return false;
		this.#advance();
		return true;
	}

	#expect(type: TokenType, message: string): void {
		if (!this.#match(type)) throw new Error(message);
	}

	#current(): Token {
		return this.#tokens[this.#index];
	}

	#previous(): Token {
		return this.#tokens[this.#index - 1];
	}

	#advance(): Token {
		return this.#tokens[this.#index++];
	}

	#finite(value: number): number {
		if (!Number.isFinite(value)) throw new Error("Calculation produced a non-finite result.");
		return Object.is(value, -0) ? 0 : value;
	}
}

export function calculate(expression: string): number {
	if (expression.trim().length === 0) throw new Error("Expression cannot be empty.");
	if (expression.length > 1_000) throw new Error("Expression exceeds 1000 characters.");
	return new ExpressionParser(expression).parse();
}

export function createCalculatorTool(): AgentTool {
	return {
		name: "calculator",
		description:
			"Evaluate a mathematical expression. Supports +, -, *, /, %, ^, parentheses, pi, e, and common math functions.",
		parameters: Type.Object({ expression: Type.String({ minLength: 1, maxLength: 1_000 }) }, { additionalProperties: false }),
		async execute(toolCall) {
			const expression = String(toolCall.arguments.expression);
			try {
				return { content: JSON.stringify({ expression, result: calculate(expression) }) };
			} catch (error) {
				return { content: error instanceof Error ? error.message : String(error), isError: true };
			}
		},
	};
}
