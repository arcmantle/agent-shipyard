import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	renderContextOutput,
	renderContextSearchTermsOnly,
	toContextSearchTermsOnly
} from "./context-cli.js";
import { createEntity, defineContextTerm, ensureDatabase, queryContextDirectory } from "@agent-issues/api-local";

let tempDir: string | null = null;
let database: { close(): void } | null = null;

async function openTestDatabase() {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-context-cli-"));
	const result = await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	database = result.db;
	return result.executor;
}

afterEach(() => {
	database?.close();
	database = null;
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("context cli rendering", () => {
	it("renders project context search output consistently", async () => {
		const db = await openTestDatabase();
		const payments = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Review Snapshot",
			definition: "Canonical stored review output.",
			scopeRef: payments.id,
			avoid: ["temporary review"]
		});
		defineContextTerm(db, {
			term: "Review Queue",
			definition: "Pending review work.",
			scopeRef: "default"
		});

		const result = queryContextDirectory(db, { query: "review" });

		expect(renderContextOutput(result).replace(payments.id, "INIT_CANONICAL")).toMatchInlineSnapshot(`
"Shared Context (default)
Scope: project directory
View: all
Query: review
Conflicts only: no
Shared context stored in database: yes
Shared summary: none
Shared terms: 1
Initiative contexts: 1
Discovered terms: 2
Duplicate labels across scopes: 0

Initiative contexts:
- Payments (INIT_CANONICAL) stored terms=1

Discovered terms:
- Review Queue
  - Shared: Pending review work.
- Review Snapshot
  - Payments: Canonical stored review output.
    Avoid: temporary review"
`);
	});

	it("renders compact terms-only output consistently", async () => {
		const db = await openTestDatabase();
		const payments = createEntity(db, { kind: "initiative", title: "Payments" });
		const shipping = createEntity(db, { kind: "initiative", title: "Shipping" });

		defineContextTerm(db, {
			term: "Order",
			definition: "Canonical order.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Payment order.",
			scopeRef: payments.id
		});
		defineContextTerm(db, {
			term: "Order hold",
			definition: "Shipping hold for fulfilment.",
			scopeRef: shipping.id
		});

		const result = queryContextDirectory(db, { query: "order" });

		expect(renderContextSearchTermsOnly(toContextSearchTermsOnly(result))).toMatchInlineSnapshot(`
"Matching context terms
View: all
Query: order
Conflicts only: no
Matches: 2
Duplicate labels across scopes: 1

Terms:
- Order [defined in 2 scopes; conflicting definitions]
  - Shared: Canonical order.
  - Payments: Payment order.
- Order hold
  - Shipping: Shipping hold for fulfilment."
`);
	});
});