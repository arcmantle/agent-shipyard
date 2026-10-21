import { describe, expect, it } from "vitest";

import {
	decodeRevisionPatchRecordKey,
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	encodeEntityRecordKey,
	encodeIssueCommentRecordKey
} from "../../index.js";

describe("revision patch record-key codec", () => {
	it("round trips entity, context, and stable context-term keys", () => {
		expect(decodeRevisionPatchRecordKey("entity", encodeEntityRecordKey("ISS:1"))).toEqual({ entityId: "ISS:1" });
		expect(decodeRevisionPatchRecordKey("context", encodeContextRecordKey("café"))).toEqual({ contextKey: "café" });
		expect(decodeRevisionPatchRecordKey("context-term", encodeContextTermRecordKey("term:018f"))).toEqual({
			contextTermId: "term:018f"
		});
		expect(decodeRevisionPatchRecordKey("issue-comment", encodeIssueCommentRecordKey("COM:1"))).toEqual({
			issueCommentId: "COM:1"
		});
	});

	it("uses UTF-8 byte lengths rather than JavaScript character counts", () => {
		expect(encodeContextRecordKey("café")).toBe("5:café");
		expect(encodeContextTermRecordKey("🚀")).toBe("4:🚀");
		expect(encodeIssueCommentRecordKey("COM:1")).toBe("5:COM:1");
	});

	it("rejects malformed, truncated, trailing, and kind-mismatched keys", () => {
		for (const [kind, key] of [
			["entity", "x:value"],
			["context", "5:caféx"],
			["context-term", "1:aextra"]
		] as const) {
			expect(() => decodeRevisionPatchRecordKey(kind, key)).toThrow("Malformed revision patch record key");
		}
	});
});