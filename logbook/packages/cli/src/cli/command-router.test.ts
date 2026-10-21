import { describe, expect, it } from "vitest";

import { loadCommandFamily } from "./command-router.js";

describe("command router", () => {
	it("loads only the entity family for a lightweight entity command", async () => {
		const loaded: string[] = [];

		const result = await loadCommandFamily(["list", "initiative"], async (family) => {
			loaded.push(family);
			return family;
		});

		expect(result).toBe("entities");
		expect(loaded).toEqual(["entities"]);
	});
});