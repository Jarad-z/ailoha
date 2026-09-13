import { ModelError, WorkspaceContextError, createAbortError } from "@ailoha/agent-core";
import { describe, expect, it } from "vitest";
import { mapServiceError } from "../src/errors.js";

describe("mapServiceError retry semantics", () => {
	it("does not invite clients to repeat a run after model retries are exhausted", () => {
		const error = mapServiceError(new ModelError("provider failed after retries"));
		expect(error.httpStatus).toBe(502);
		expect(error.serviceError).toEqual({
			code: "model_request_failed",
			message: "The model request failed.",
			retryable: false,
		});
	});

	it("does not mark an already-aborted operation as retryable", () => {
		const error = mapServiceError(createAbortError());
		expect(error.serviceError).toMatchObject({ code: "operation_aborted", retryable: false });
	});

	it("maps workspace validation and AGENTS.md failures without exposing paths", () => {
		const invalidCwd = mapServiceError(new WorkspaceContextError(
			"WORKSPACE_CWD_INVALID",
			"invalid cwd",
		));
		expect(invalidCwd.httpStatus).toBe(400);
		expect(invalidCwd.serviceError).toMatchObject({
			code: "invalid_request",
			retryable: false,
			details: { code: "WORKSPACE_CWD_INVALID" },
		});

		const unreadable = mapServiceError(new WorkspaceContextError(
			"WORKSPACE_INSTRUCTIONS_UNREADABLE",
			"secret absolute path must not escape",
			{ fileName: "AGENTS.md" },
		));
		expect(unreadable.httpStatus).toBe(422);
		expect(unreadable.serviceError).toEqual({
			code: "workspace_context_failed",
			message: "Workspace instructions could not be loaded.",
			retryable: false,
			details: { code: "WORKSPACE_INSTRUCTIONS_UNREADABLE", fileName: "AGENTS.md" },
		});
	});
});
