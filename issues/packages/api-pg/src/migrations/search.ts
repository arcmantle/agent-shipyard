import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const searchMigration: Migration = {
	id: "search",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("PostgreSQL search migration requires the PostgreSQL dialect.");
		}

		await conn.run(sql`CREATE INDEX entities_search_idx ON entities USING GIN (to_tsvector('simple', title || ' ' || body))`);
		await conn.run(sql`CREATE INDEX contexts_search_idx ON contexts USING GIN (to_tsvector('simple', title || ' ' || summary))`);
		await conn.run(sql`CREATE INDEX context_terms_search_idx ON context_terms USING GIN (to_tsvector('simple', term || ' ' || definition))`);
		await conn.run(sql`CREATE INDEX issue_comments_search_idx ON issue_comments USING GIN (to_tsvector('simple', body))`);
		await conn.run(sql`CREATE INDEX plan_entries_search_idx ON plan_entries USING GIN (to_tsvector('simple', body))`);
	}
};