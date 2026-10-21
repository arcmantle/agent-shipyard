import { describe, expect, it } from "vitest";

import { deriveMigratedContextTermId, generateContextTermId } from "./context-term-id.js";

describe("context term stable IDs", () => {
	it("derives convergent migrated IDs and generates independent new IDs", () => {
		const first = deriveMigratedContextTermId("default:PROJ1", "Order");
		const second = deriveMigratedContextTermId("default:PROJ1", "Order");

		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(deriveMigratedContextTermId("default:PROJ2", "Order")).not.toBe(first);
		expect(deriveMigratedContextTermId("default:PROJ1", "Settlement")).not.toBe(first);
		expect(generateContextTermId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});