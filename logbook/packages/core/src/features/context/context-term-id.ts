import { createHash, randomUUID } from "node:crypto";

const MIGRATED_CONTEXT_TERM_ID_NAMESPACE = "agent-issues/context-term-id/v1";

function encodeIdentityPart(value: string): string {
	return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function formatUuid(bytes: Uint8Array): string {
	const hex = Buffer.from(bytes).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveMigratedContextTermId(contextKey: string, term: string): string {
	const bytes = createHash("sha256")
		.update(MIGRATED_CONTEXT_TERM_ID_NAMESPACE)
		.update("\0")
		.update(encodeIdentityPart(contextKey))
		.update(encodeIdentityPart(term))
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	return formatUuid(bytes);
}

export function generateContextTermId(): string {
	return randomUUID();
}