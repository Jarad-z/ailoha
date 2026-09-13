export class ChatCompletionsConfigError extends Error {
	override readonly name = "ChatCompletionsConfigError";
}

export class ChatCompletionsHttpError extends Error {
	override readonly name = "ChatCompletionsHttpError";
	readonly status: number;

	constructor(status: number, message: string, options?: ErrorOptions) {
		super(message, options);
		this.status = status;
	}
}

export class ChatCompletionsProtocolError extends Error {
	override readonly name = "ChatCompletionsProtocolError";
}

export class UnsupportedContentError extends Error {
	override readonly name = "UnsupportedContentError";
}
