import { createHash, randomUUID } from "node:crypto";

import { ENTITY_KINDS, ID_PREFIX, type EntityKind } from "./domain.js";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_DECODE = new Map([...CROCKFORD_ALPHABET].map((character, index) => [character, BigInt(index)]));
const ENCODED_UUID_LENGTH = 26;
const REFERENCE_SEPARATOR = "_";
const MIGRATED_ENTITY_ID_NAMESPACE = "agent-issues/entity-stable-id/v1";
const MIGRATED_CONTEXT_ID_NAMESPACE = "agent-issues/context-stable-id/v1";
const CANONICAL_REFERENCE_PREFIX = { ...ID_PREFIX, context: "CTX", contextTerm: "TERM", issueComment: "COM", planEntry: "PLAN_ENTRY" } as const;
const SHORT_REFERENCE_PREFIX = CANONICAL_REFERENCE_PREFIX;
const CANONICAL_REFERENCE_KINDS = ["planEntry", ...ENTITY_KINDS, "context", "contextTerm", "issueComment"] as const;

export type CanonicalReferenceKind = (typeof CANONICAL_REFERENCE_KINDS)[number];

export type DecodedCanonicalReference = {
	kind: CanonicalReferenceKind;
	stableId: string;
};

export function encodeCanonicalReference(kind: CanonicalReferenceKind, stableId: string): string {
	let value = uuidToBigInt(stableId);
	let encoded = "";
	for (let index = 0; index < ENCODED_UUID_LENGTH; index += 1) {
		encoded = CROCKFORD_ALPHABET[Number(value & 31n)]! + encoded;
		value >>= 5n;
	}
	return `${CANONICAL_REFERENCE_PREFIX[kind]}${REFERENCE_SEPARATOR}${encoded}`;
}

export function decodeCanonicalReference(reference: string): DecodedCanonicalReference {
	if (reference !== reference.toUpperCase()) {
		throw new Error(`Canonical reference must use uppercase Crockford Base32: ${reference}`);
	}
	const kind = CANONICAL_REFERENCE_KINDS.find((candidate) => reference.startsWith(CANONICAL_REFERENCE_PREFIX[candidate]));
	if (!kind) {
		throw new Error(`Invalid canonical reference prefix: ${reference}`);
	}

	const separatorIndex = CANONICAL_REFERENCE_PREFIX[kind].length;
	if (reference[separatorIndex] !== REFERENCE_SEPARATOR) {
		throw new Error(`Canonical reference must separate kind and identity with _: ${reference}`);
	}

	const encoded = reference.slice(separatorIndex + REFERENCE_SEPARATOR.length);
	if (encoded.length !== ENCODED_UUID_LENGTH) {
		throw new Error(`Invalid canonical reference length: ${reference}`);
	}

	let value = 0n;
	for (const character of encoded) {
		const digit = CROCKFORD_DECODE.get(character);
		if (digit === undefined) {
			throw new Error(`Invalid canonical reference character: ${character}`);
		}
		value = (value << 5n) | digit;
	}
	if (value >= (1n << 128n)) {
		throw new Error(`Canonical reference exceeds UUID entropy: ${reference}`);
	}

	const stableId = formatUuid(value.toString(16).padStart(32, "0"));
	if (encodeCanonicalReference(kind, stableId) !== reference) {
		throw new Error(`Noncanonical canonical reference: ${reference}`);
	}
	return { kind, stableId };
}

export function generateCanonicalIdentity(kind: EntityKind): { stableId: string; reference: string } {
	const stableId = randomUUID();
	return { stableId, reference: encodeCanonicalReference(kind, stableId) };
}

export function shortEntityReference(entity: { id: string; kind: string; shortReference?: string }): string {
	if (entity.shortReference) {
		return entity.shortReference;
	}

	const prefix = SHORT_REFERENCE_PREFIX[entity.kind as CanonicalReferenceKind] ?? entity.kind.slice(0, 4).toUpperCase();
	let hash = 0x811c9dc5;
	for (let index = 0; index < entity.id.length; index += 1) {
		hash ^= entity.id.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	let value = BigInt(hash >>> 0);
	let code = "";
	for (let index = 0; index < 6; index += 1) {
		code = CROCKFORD_ALPHABET[Number(value & 31n)]! + code;
		value >>= 5n;
	}
	return `${prefix}_${code}`;
}

const STABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a selector names one specific record - a stable id or a Canonical
 * reference - as opposed to a human/repository-style name that is matched by
 * normalized title. Both storage drivers key the same decision on this: a
 * direct selector that resolves to nothing is a genuine lookup failure and
 * must stay an error, while an unmatched repository-style identity is a
 * workspace that has simply not registered its project yet.
 */
export function isDirectEntitySelector(selector: string): boolean {
	if (STABLE_ID_PATTERN.test(selector)) {
		return true;
	}

	try {
		decodeCanonicalReference(selector);
		return true;
	} catch {
		return false;
	}
}

export function deriveMigratedEntityIdentity(
	kind: EntityKind,
	legacyAlias: string
): { stableId: string; reference: string } {
	const bytes = createHash("sha256")
		.update(MIGRATED_ENTITY_ID_NAMESPACE)
		.update("\0")
		.update(`${Buffer.byteLength(kind, "utf8")}:${kind}`)
		.update(`${Buffer.byteLength(legacyAlias, "utf8")}:${legacyAlias}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const stableId = formatUuid(bytes.toString("hex"));
	return { stableId, reference: encodeCanonicalReference(kind, stableId) };
}

export function generateContextIdentity(): { stableId: string; reference: string } {
	const stableId = randomUUID();
	return { stableId, reference: encodeCanonicalReference("context", stableId) };
}

export function deriveMigratedContextIdentity(contextKey: string): { stableId: string; reference: string } {
	const stableId = deriveNamespacedStableId(MIGRATED_CONTEXT_ID_NAMESPACE, contextKey);
	return { stableId, reference: encodeCanonicalReference("context", stableId) };
}

function deriveNamespacedStableId(namespace: string, value: string): string {
	const bytes = createHash("sha256")
		.update(namespace)
		.update("\0")
		.update(`${Buffer.byteLength(value, "utf8")}:${value}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	return formatUuid(bytes.toString("hex"));
}

function uuidToBigInt(stableId: string): bigint {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stableId)) {
		throw new Error(`Invalid stable UUID: ${stableId}`);
	}
	return BigInt(`0x${stableId.replaceAll("-", "")}`);
}

function formatUuid(hex: string): string {
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}