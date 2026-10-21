import { describe, expect, it } from "vitest";

import type { CanonicalChainBundle } from "../synchronize/canonical-chain.js";
import { measureHistory } from "./history-diagnostics.js";

describe("measureHistory", () => {
	it("counts decoded binary reverse-patch payload bytes", () => {
		const bundle = {
			entities: [{
				head: { id: "ISS1" },
				deltas: [
					{ reversePatch: Uint8Array.from([1, 2, 3]) },
					{ reversePatch: Uint8Array.from([4, 5]) }
				]
			}],
			contexts: [],
			contextTerms: []
		} as unknown as CanonicalChainBundle;

		const diagnostics = measureHistory(bundle, { entity: 0, context: 0, "context-term": 0 });

		expect(diagnostics.entity.historyBytes).toBe(5);
		expect(diagnostics.entity.records).toEqual([{ recordId: "ISS1", deltaCount: 2, historyBytes: 5 }]);
	});
});