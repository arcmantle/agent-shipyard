import { afterEach, describe, expect, it } from "vitest";

import "./record-browser-elements.js";
import type { Entity } from "../models.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("record list item", () => {
	it("uses the same visual treatment as a tree record row", async () => {
		const item = document.createElement("agent-issues-record-list-item");
		item.record = {
			body: "",
			createdAt: "2026-01-01T00:00:00.000Z",
			id: "ISS1",
			kind: "issue",
			status: "todo",
			title: "Match tree styling",
			updatedAt: "2026-01-01T00:00:00.000Z"
		} satisfies Entity;
		item.reference = "ISS_ABC123";
		document.body.appendChild(item);
		await item.updateComplete;

		const styleResults = (item.constructor as typeof item.constructor & { styles: Array<{ cssText: string }> }).styles;
		const styles = styleResults.map((style) => style.cssText).join("\n");
		expect(styles).toContain("padding: 10px 12px");
		expect(styles).toContain("border: 1px solid var(--border)");
		expect(styles).toContain("border-radius: 8px");
		expect(styles).toContain("background: var(--surface)");
		expect(styles).toContain("font-weight: 600");
		expect(styles).toContain("min-height: 28px");
		expect(styles).toContain("padding: 0 10px");
	});
});