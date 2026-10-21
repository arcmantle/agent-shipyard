export const REVISION_PATCH_RECORD_KINDS = ["entity", "context", "context-term", "issue-comment", "plan-entry"] as const;

export type RevisionPatchRecordKind = (typeof REVISION_PATCH_RECORD_KINDS)[number];

export type DecodedRevisionPatchRecordKey =
	| { entityId: string }
	| { contextKey: string }
	| { contextTermId: string }
	| { issueCommentId: string }
	| { planEntryId: string };

type DecodedPart = {
	value: string;
	nextOffset: number;
};

const MALFORMED_RECORD_KEY = "Malformed revision patch record key.";

function encodePart(value: string): string {
	return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function decodePart(bytes: Buffer, offset: number): DecodedPart {
	const separator = bytes.indexOf(58, offset);
	if (separator === -1) {
		throw new Error(MALFORMED_RECORD_KEY);
	}
	const lengthText = bytes.subarray(offset, separator).toString("ascii");
	if (!/^(0|[1-9]\d*)$/.test(lengthText)) {
		throw new Error(MALFORMED_RECORD_KEY);
	}
	const length = Number(lengthText);
	const valueStart = separator + 1;
	const nextOffset = valueStart + length;
	if (!Number.isSafeInteger(length) || nextOffset > bytes.length) {
		throw new Error(MALFORMED_RECORD_KEY);
	}
	const valueBytes = bytes.subarray(valueStart, nextOffset);
	const value = valueBytes.toString("utf8");
	if (!Buffer.from(value, "utf8").equals(valueBytes)) {
		throw new Error(MALFORMED_RECORD_KEY);
	}
	return { value, nextOffset };
}

export function encodeEntityRecordKey(entityId: string): string {
	return encodePart(entityId);
}

export function encodeContextRecordKey(contextKey: string): string {
	return encodePart(contextKey);
}

export function encodeContextTermRecordKey(contextTermId: string): string {
	return encodePart(contextTermId);
}

export function encodeIssueCommentRecordKey(issueCommentId: string): string {
	return encodePart(issueCommentId);
}

export function encodePlanEntryRecordKey(planEntryId: string): string {
	return encodePart(planEntryId);
}

export function decodeRevisionPatchRecordKey(
	recordKind: RevisionPatchRecordKind,
	recordKey: string
): DecodedRevisionPatchRecordKey {
	const bytes = Buffer.from(recordKey, "utf8");
	const first = decodePart(bytes, 0);
	if (first.nextOffset !== bytes.length) {
		throw new Error(MALFORMED_RECORD_KEY);
	}
	if (recordKind === "entity") {
		return { entityId: first.value };
	}
	if (recordKind === "context") {
		return { contextKey: first.value };
	}
	if (recordKind === "context-term") {
		return { contextTermId: first.value };
	}
	return recordKind === "issue-comment"
		? { issueCommentId: first.value }
		: { planEntryId: first.value };
}