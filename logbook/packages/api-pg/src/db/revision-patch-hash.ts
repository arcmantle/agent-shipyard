const CANONICAL_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function encodeRevisionPatchHash(hash: string): Buffer {
	if (!CANONICAL_HASH_PATTERN.test(hash)) {
		throw new Error("Revision patch hash must be a lowercase 64-character hexadecimal string.");
	}
	return Buffer.from(hash, "hex");
}

export function decodeRevisionPatchHash(hash: Uint8Array): string {
	if (hash.byteLength !== 32) {
		throw new Error("Stored revision patch hash must contain exactly 32 bytes.");
	}
	return Buffer.from(hash).toString("hex");
}