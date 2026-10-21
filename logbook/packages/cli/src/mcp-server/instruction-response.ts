import { createHash } from "node:crypto";
import type { RetrievedInstruction } from "@agent-issues/core";
import { formatMarkdownResponse } from "./markdown-response.js";

export function formatInstructionResponse(instruction: RetrievedInstruction, offset = 0, expectedDocumentHash?: string) {
	const documentHash = createHash("sha256").update(JSON.stringify(instruction)).digest("hex");
	return formatMarkdownResponse(instruction.body, { version: instruction.version }, documentHash, "instruction_retrieve", offset, expectedDocumentHash);
}