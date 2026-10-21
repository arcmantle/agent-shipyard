import { createHash } from "node:crypto";

const PATCH_FORMAT_VERSION = 1;
const COPY_OPCODE = 1;
const SKIP_OPCODE = 2;
const INSERT_OPCODE = 3;
const REPLACE_OPCODE = 4;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type ReversePatchField = {
	id: number;
	key: string;
	kind: "text" | "value";
};

export type ReversePatchRegistry = readonly ReversePatchField[];

export type ReverseFieldPatchTransition = {
	patchFormat: number;
	reversePatch: Uint8Array;
	sourceHash: string;
	targetHash: string;
};

export const ENTITY_REVERSE_PATCH_REGISTRY = [
	{ id: 1, key: "title", kind: "text" },
	{ id: 2, key: "body", kind: "text" },
	{ id: 3, key: "bodySource", kind: "value" },
	{ id: 4, key: "status", kind: "value" },
	{ id: 5, key: "parentId", kind: "value" },
	{ id: 6, key: "tombstone", kind: "value" },
	{ id: 7, key: "category", kind: "value" },
	{ id: 8, key: "priority", kind: "value" },
	{ id: 9, key: "type", kind: "value" }
] as const satisfies ReversePatchRegistry;

export const CONTEXT_REVERSE_PATCH_REGISTRY = [
	{ id: 1, key: "title", kind: "text" },
	{ id: 2, key: "summary", kind: "text" }
] as const satisfies ReversePatchRegistry;

export const CONTEXT_TERM_REVERSE_PATCH_REGISTRY = [
	{ id: 1, key: "definition", kind: "text" },
	{ id: 2, key: "avoid", kind: "value" },
	{ id: 3, key: "tombstone", kind: "value" },
	{ id: 4, key: "term", kind: "text" }
] as const satisfies ReversePatchRegistry;

export const ISSUE_COMMENT_REVERSE_PATCH_REGISTRY = [
	{ id: 1, key: "body", kind: "text" },
	{ id: 2, key: "referencedIssueIds", kind: "value" },
	{ id: 3, key: "tombstone", kind: "value" }
] as const satisfies ReversePatchRegistry;

export const PLAN_ENTRY_REVERSE_PATCH_REGISTRY = [
	{ id: 1, key: "role", kind: "value" },
	{ id: 2, key: "body", kind: "text" },
	{ id: 3, key: "scopeDirection", kind: "value" },
	{ id: 4, key: "referencedEntityIds", kind: "value" },
	{ id: 5, key: "supersededEntryIds", kind: "value" },
	{ id: 6, key: "tombstone", kind: "value" }
] as const satisfies ReversePatchRegistry;

export function computeCanonicalStateHash(state: object, registry: ReversePatchRegistry): string {
	const values = registry.map((field) => [field.id, Reflect.get(state, field.key)]);
	return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function valuesMatch(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function createReverseFieldPatch<State extends object>(
	successor: State,
	predecessor: State,
	registry: ReversePatchRegistry
): ReverseFieldPatchTransition {
	const output: number[] = [];
	for (const field of registry) {
		const successorValue = Reflect.get(successor, field.key) as unknown;
		const predecessorValue = Reflect.get(predecessor, field.key) as unknown;
		if (valuesMatch(successorValue, predecessorValue)) {
			continue;
		}
		const payload = field.kind === "text"
			? createReverseTextPatch(String(successorValue), String(predecessorValue))
			: textEncoder.encode(JSON.stringify(predecessorValue));
		output.push(...encodeUnsignedVarint(field.id), field.kind === "text" ? 1 : 2, ...encodeUnsignedVarint(payload.byteLength));
		appendBytes(output, payload);
	}
	return {
		patchFormat: PATCH_FORMAT_VERSION,
		reversePatch: Uint8Array.from(output),
		sourceHash: computeCanonicalStateHash(successor, registry),
		targetHash: computeCanonicalStateHash(predecessor, registry)
	};
}

export function applyReverseFieldPatch<State extends object>(
	successor: State,
	transition: ReverseFieldPatchTransition,
	registry: ReversePatchRegistry
): State {
	if (transition.patchFormat !== PATCH_FORMAT_VERSION) {
		throw new Error(`Unsupported reverse field patch format ${transition.patchFormat}.`);
	}
	if (computeCanonicalStateHash(successor, registry) !== transition.sourceHash) {
		throw new Error("Broken reverse field patch chain: source hash mismatch.");
	}
	const predecessor = Object.assign({}, successor) as State;
	const appliedFieldIds = new Set<number>();
	let offset = 0;
	while (offset < transition.reversePatch.byteLength) {
		const decodedFieldId = decodeUnsignedVarint(transition.reversePatch, offset);
		offset = decodedFieldId.offset;
		if (appliedFieldIds.has(decodedFieldId.value)) {
			throw new Error(`Malformed reverse field patch: duplicate field ${decodedFieldId.value}.`);
		}
		appliedFieldIds.add(decodedFieldId.value);
		const encodingKind = transition.reversePatch[offset++];
		const decodedLength = decodeUnsignedVarint(transition.reversePatch, offset);
		offset = decodedLength.offset;
		const payloadEnd = offset + decodedLength.value;
		if (payloadEnd > transition.reversePatch.byteLength) {
			throw new Error("Malformed reverse field patch: payload is out of range.");
		}
		const field = registry.find((candidate) => candidate.id === decodedFieldId.value);
		if (!field) {
			throw new Error(`Malformed reverse field patch: unknown field ${decodedFieldId.value}.`);
		}
		const payload = transition.reversePatch.subarray(offset, payloadEnd);
		const currentValue = Reflect.get(predecessor, field.key) as unknown;
		const priorValue = encodingKind === 1
			? applyReverseTextPatch(String(currentValue), payload)
			: encodingKind === 2
				? JSON.parse(textDecoder.decode(payload)) as unknown
				: undefined;
		if (priorValue === undefined) {
			throw new Error(`Malformed reverse field patch: unknown encoding ${encodingKind}.`);
		}
		Reflect.set(predecessor, field.key, priorValue);
		offset = payloadEnd;
	}
	if (computeCanonicalStateHash(predecessor, registry) !== transition.targetHash) {
		throw new Error("Broken reverse field patch chain: target hash mismatch.");
	}
	return predecessor;
}

function encodeUnsignedVarint(value: number): number[] {
	const bytes: number[] = [];
	let remaining = value;
	do {
		const next = remaining % 128;
		remaining = Math.floor(remaining / 128);
		bytes.push(remaining === 0 ? next : next | 0x80);
	} while (remaining > 0);
	return bytes;
}

function decodeUnsignedVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } {
	let value = 0;
	let multiplier = 1;
	let cursor = offset;
	while (cursor < bytes.byteLength) {
		const byte = bytes[cursor++];
		value += (byte & 0x7f) * multiplier;
		if ((byte & 0x80) === 0) {
			return { value, offset: cursor };
		}
		multiplier *= 128;
	}
	throw new Error("Malformed reverse text patch: unterminated length.");
}

function appendOperation(output: number[], opcode: number, bytes: Uint8Array): void {
	output.push(opcode, ...encodeUnsignedVarint(bytes.byteLength));
	if (opcode === INSERT_OPCODE || opcode === REPLACE_OPCODE) {
		for (const byte of bytes) {
			output.push(byte);
		}
	}
}

function appendBytes(output: number[], bytes: Uint8Array): void {
	for (const byte of bytes) {
		output.push(byte);
	}
}

function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
	return offset === 0 || offset === bytes.byteLength || (bytes[offset] & 0xc0) !== 0x80;
}

export function createReverseTextPatch(successor: string, predecessor: string): Uint8Array {
	const successorCharacters = Array.from(successor);
	const predecessorCharacters = Array.from(predecessor);
	let prefixLength = 0;
	while (
		prefixLength < successorCharacters.length
		&& prefixLength < predecessorCharacters.length
		&& successorCharacters[prefixLength] === predecessorCharacters[prefixLength]
	) {
		prefixLength++;
	}

	let suffixLength = 0;
	while (
		suffixLength < successorCharacters.length - prefixLength
		&& suffixLength < predecessorCharacters.length - prefixLength
		&& successorCharacters[successorCharacters.length - suffixLength - 1]
			=== predecessorCharacters[predecessorCharacters.length - suffixLength - 1]
	) {
		suffixLength++;
	}

	const prefix = textEncoder.encode(successorCharacters.slice(0, prefixLength).join(""));
	const removed = textEncoder.encode(successorCharacters.slice(prefixLength, successorCharacters.length - suffixLength).join(""));
	const inserted = textEncoder.encode(predecessorCharacters.slice(prefixLength, predecessorCharacters.length - suffixLength).join(""));
	const suffix = textEncoder.encode(successorCharacters.slice(successorCharacters.length - suffixLength).join(""));
	const output = [PATCH_FORMAT_VERSION];
	if (prefix.byteLength > 0) {
		appendOperation(output, COPY_OPCODE, prefix);
	}
	if (removed.byteLength > 0) {
		appendOperation(output, SKIP_OPCODE, removed);
	}
	if (inserted.byteLength > 0) {
		appendOperation(output, INSERT_OPCODE, inserted);
	}
	if (suffix.byteLength > 0) {
		appendOperation(output, COPY_OPCODE, suffix);
	}
	const replacement = [PATCH_FORMAT_VERSION];
	appendOperation(replacement, REPLACE_OPCODE, textEncoder.encode(predecessor));
	return Uint8Array.from(replacement.length < output.length ? replacement : output);
}

export function applyReverseTextPatch(successor: string, patch: Uint8Array): string {
	if (patch[0] !== PATCH_FORMAT_VERSION) {
		throw new Error("Unsupported reverse text patch format.");
	}
	const source = textEncoder.encode(successor);
	const output: number[] = [];
	let sourceOffset = 0;
	let patchOffset = 1;
	while (patchOffset < patch.byteLength) {
		const opcode = patch[patchOffset++];
		const decodedLength = decodeUnsignedVarint(patch, patchOffset);
		const length = decodedLength.value;
		patchOffset = decodedLength.offset;
		if (opcode === COPY_OPCODE || opcode === SKIP_OPCODE) {
			if (sourceOffset + length > source.byteLength) {
				throw new Error("Malformed reverse text patch: source read is out of range.");
			}
			if (!isUtf8Boundary(source, sourceOffset) || !isUtf8Boundary(source, sourceOffset + length)) {
				throw new Error("Malformed reverse text patch: operation splits a UTF-8 boundary.");
			}
			if (opcode === COPY_OPCODE) {
				appendBytes(output, source.subarray(sourceOffset, sourceOffset + length));
			}
			sourceOffset += length;
			continue;
		}
		if (opcode === INSERT_OPCODE) {
			if (patchOffset + length > patch.byteLength) {
				throw new Error("Malformed reverse text patch: inserted bytes are out of range.");
			}
			appendBytes(output, patch.subarray(patchOffset, patchOffset + length));
			patchOffset += length;
			continue;
		}
		if (opcode === REPLACE_OPCODE) {
			if (patchOffset + length !== patch.byteLength) {
				throw new Error("Malformed reverse text patch: replacement bytes are out of range.");
			}
			return textDecoder.decode(patch.subarray(patchOffset, patchOffset + length));
		}
		throw new Error(`Malformed reverse text patch: unknown opcode ${opcode}.`);
	}
	if (sourceOffset !== source.byteLength) {
		throw new Error("Malformed reverse text patch: source bytes were not fully consumed.");
	}
	return textDecoder.decode(Uint8Array.from(output));
}