import { describe, expect, it } from "vitest";

import {
	decodeCanonicalReference,
	deriveMigratedEntityIdentity,
	encodeCanonicalReference
} from "./canonical-reference.js";

describe("Canonical reference", () => {
	it("reversibly encodes all standard UUID bytes with a kind prefix", () => {
		const stableId = "ffffffff-ffff-ffff-ffff-ffffffffffff";

		const reference = encodeCanonicalReference("issue", stableId);

		expect(reference).toBe("ISS_7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
		expect(decodeCanonicalReference(reference)).toEqual({ kind: "issue", stableId });
	});

	it("rejects overflow, lowercase, ambiguous, and invalid encodings", () => {
		for (const reference of [
			"ISS80000000000000000000000000",
			"ISS0000000000000000000000000a",
			"ISS0000000000000000000000000I",
			"ISS0000000000000000000000000U"
		]) {
			expect(() => decodeCanonicalReference(reference)).toThrow();
		}
	});

	it("deterministically derives equivalent migrated identities from a Legacy alias", () => {
		const first = deriveMigratedEntityIdentity("issue", "ISS312");
		const second = deriveMigratedEntityIdentity("issue", "ISS312");

		expect(first).toEqual(second);
		expect(first.stableId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(decodeCanonicalReference(first.reference)).toEqual({ kind: "issue", stableId: first.stableId });
	});

	it("uses the same reversible UUID encoding for contexts and context terms", () => {
		const stableId = "00000000-0000-0000-0000-000000000001";

		expect(encodeCanonicalReference("context", stableId)).toBe("CTX_00000000000000000000000001");
		expect(encodeCanonicalReference("contextTerm", stableId)).toBe("TERM_00000000000000000000000001");
		expect(decodeCanonicalReference("CTX_00000000000000000000000001")).toEqual({ kind: "context", stableId });
		expect(decodeCanonicalReference("TERM_00000000000000000000000001")).toEqual({ kind: "contextTerm", stableId });
	});

	it("encodes and decodes issue comment references", () => {
		const stableId = "00000000-0000-4000-8000-000000000001";
		const reference = encodeCanonicalReference("issueComment", stableId);

		expect(reference).toBe("COM_00000000008008000000000001");
		expect(decodeCanonicalReference(reference)).toEqual({ kind: "issueComment", stableId });
	});
});