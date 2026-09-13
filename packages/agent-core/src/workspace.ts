import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkspaceContextError, createAbortError, isAbortError } from "./errors.js";
import type {
	SessionWorkspace,
	SessionWorkspaceOptions,
	WorkspaceInstructionFile,
	WorkspaceInstructionLoadRequest,
} from "./types.js";

export const AGENTS_MD_FILE_NAME = "AGENTS.md";
export const MAX_AGENTS_MD_BYTES = 64 * 1024;

const WORKSPACE_INSTRUCTION_HEADER =
	"Workspace-specific instructions loaded from AGENTS.md follow. They apply to this workspace and may refine, but must not override, earlier system instructions.";

function invalidCwd(message: string): WorkspaceContextError {
	return new WorkspaceContextError("WORKSPACE_CWD_INVALID", message);
}

function instructionError(
	code: Exclude<import("./errors.js").WorkspaceContextErrorCode, "WORKSPACE_CWD_INVALID">,
	message: string,
	cause?: unknown,
): WorkspaceContextError {
	return new WorkspaceContextError(code, message, {
		fileName: AGENTS_MD_FILE_NAME,
		...(cause === undefined ? {} : { cause }),
	});
}

function fileErrorCode(value: unknown): string | undefined {
	return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
		? value.code
		: undefined;
}

function sha256(value: Buffer): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function resolveSessionWorkspace(
	input: SessionWorkspaceOptions | undefined,
	fallbackCwd: string,
): SessionWorkspace {
	const source = input?.cwd ?? fallbackCwd;
	if (typeof source !== "string") throw invalidCwd("Workspace cwd must be a string.");
	if (source.trim().length === 0) throw invalidCwd("Workspace cwd must not be empty.");
	if (source.includes("\0")) throw invalidCwd("Workspace cwd must not contain NUL characters.");
	return Object.freeze({ cwd: resolve(source) });
}

export function normalizeWorkspaceInstructionFile(
	input: WorkspaceInstructionFile | undefined,
): WorkspaceInstructionFile | undefined {
	if (input === undefined) return undefined;
	if (!input || typeof input.content !== "string") {
		throw instructionError(
			"WORKSPACE_INSTRUCTIONS_UNREADABLE",
			"Workspace instruction loader returned invalid content.",
		);
	}
	let content = input.content;
	if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
	content = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length > MAX_AGENTS_MD_BYTES) {
		throw instructionError(
			"WORKSPACE_INSTRUCTIONS_TOO_LARGE",
			`AGENTS.md exceeds the ${MAX_AGENTS_MD_BYTES}-byte limit.`,
		);
	}
	if (content.trim().length === 0) return undefined;
	return Object.freeze({ content, byteLength: bytes.length, sha256: sha256(bytes) });
}

export async function loadWorkspaceInstructions(
	request: WorkspaceInstructionLoadRequest,
): Promise<WorkspaceInstructionFile | undefined> {
	const filePath = join(request.workspace.cwd, AGENTS_MD_FILE_NAME);
	request.signal.throwIfAborted();

	try {
		let metadata;
		try {
			metadata = await lstat(filePath);
		} catch (cause) {
			if (fileErrorCode(cause) === "ENOENT") return undefined;
			throw cause;
		}
		request.signal.throwIfAborted();
		if (metadata.isSymbolicLink() || !metadata.isFile()) {
			throw instructionError(
				"WORKSPACE_INSTRUCTIONS_NOT_REGULAR_FILE",
				"AGENTS.md must be a regular file and must not be a symbolic link.",
			);
		}
		if (metadata.size > MAX_AGENTS_MD_BYTES) {
			throw instructionError(
				"WORKSPACE_INSTRUCTIONS_TOO_LARGE",
				`AGENTS.md exceeds the ${MAX_AGENTS_MD_BYTES}-byte limit.`,
			);
		}

		const handle = await open(filePath, "r");
		let bytes: Buffer;
		try {
			const buffer = Buffer.alloc(MAX_AGENTS_MD_BYTES + 1);
			let offset = 0;
			while (offset < buffer.length) {
				request.signal.throwIfAborted();
				const result = await handle.read(buffer, offset, buffer.length - offset, offset);
				if (result.bytesRead === 0) break;
				offset += result.bytesRead;
			}
			request.signal.throwIfAborted();
			if (offset > MAX_AGENTS_MD_BYTES) {
				throw instructionError(
					"WORKSPACE_INSTRUCTIONS_TOO_LARGE",
					`AGENTS.md exceeds the ${MAX_AGENTS_MD_BYTES}-byte limit.`,
				);
			}
			bytes = buffer.subarray(0, offset);
		} finally {
			await handle.close();
		}

		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (cause) {
			throw instructionError(
				"WORKSPACE_INSTRUCTIONS_INVALID_UTF8",
				"AGENTS.md must contain valid UTF-8 text.",
				cause,
			);
		}
		return normalizeWorkspaceInstructionFile({
			content,
			byteLength: bytes.length,
			sha256: sha256(bytes),
		});
	} catch (cause) {
		if (cause instanceof WorkspaceContextError || isAbortError(cause)) throw cause;
		if (request.signal.aborted) throw createAbortError();
		if (fileErrorCode(cause) === "ENOENT") return undefined;
		throw instructionError(
			"WORKSPACE_INSTRUCTIONS_UNREADABLE",
			"AGENTS.md could not be read.",
			cause,
		);
	}
}

export function renderWorkspaceInstructions(content: string): string {
	return `${WORKSPACE_INSTRUCTION_HEADER}\n\n${content}`;
}
