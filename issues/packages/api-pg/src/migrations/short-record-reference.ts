import { shortEntityReference } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

type RecordRow = {
	tenant_id: string;
	id: string;
};

export const shortRecordReferenceMigration: Migration = {
	id: "short-record-reference",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres short record reference migration requires the PostgreSQL dialect.");
		}

		await conn.run(sql`ALTER TABLE contexts ADD COLUMN short_reference TEXT`);
		await conn.run(sql`ALTER TABLE context_terms ADD COLUMN short_reference TEXT`);
		await conn.run(sql`ALTER TABLE issue_comments ADD COLUMN short_reference TEXT`);
		await backfillShortReferences(conn, "contexts", "context");
		await backfillShortReferences(conn, "context_terms", "contextTerm");
		await backfillShortReferences(conn, "issue_comments", "issueComment");
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_short_reference_idx ON contexts (tenant_id, short_reference)`);
		await conn.run(sql`CREATE UNIQUE INDEX context_terms_tenant_short_reference_idx ON context_terms (tenant_id, short_reference)`);
		await conn.run(sql`CREATE UNIQUE INDEX issue_comments_tenant_short_reference_idx ON issue_comments (tenant_id, short_reference)`);
	}
};

async function backfillShortReferences(conn: Parameters<Migration["up"]>[0], table: "contexts" | "context_terms" | "issue_comments", kind: "context" | "contextTerm" | "issueComment"): Promise<void> {
	const records = await conn.all<RecordRow>(sql.raw(`SELECT tenant_id, id FROM ${table} ORDER BY tenant_id, id`));
	const referencesByTenant = new Map<string, Set<string>>();
	const shortReferences: Array<{ id: string; short_reference: string; tenant_id: string }> = [];

	for (const record of records) {
		const usedReferences = referencesByTenant.get(record.tenant_id) ?? new Set<string>();
		referencesByTenant.set(record.tenant_id, usedReferences);
		const baseReference = shortEntityReference({ id: record.id, kind });
		let reference = baseReference;
		let suffix = 2;
		while (usedReferences.has(reference)) {
			reference = `${baseReference}-${suffix}`;
			suffix += 1;
		}
		usedReferences.add(reference);
		shortReferences.push({ id: record.id, short_reference: reference, tenant_id: record.tenant_id });
	}

	await conn.run(sql`UPDATE ${sql.raw(table)} AS record
		SET short_reference = source.short_reference
		FROM jsonb_to_recordset(${JSON.stringify(shortReferences)}::jsonb) AS source(tenant_id TEXT, id TEXT, short_reference TEXT)
		WHERE record.tenant_id = source.tenant_id AND record.id = source.id::uuid`);
}