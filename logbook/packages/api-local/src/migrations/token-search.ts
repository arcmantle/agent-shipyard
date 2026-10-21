import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const tokenSearchMigration: Migration = {
	id: "token-search",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite token search migration requires the SQLite dialect.");
		}

		await conn.run(sql`CREATE VIRTUAL TABLE search_documents_fts USING fts5(
			title, body,
			content = 'search_documents',
			content_rowid = 'rowid',
			tokenize = 'unicode61 remove_diacritics 2'
		)`);
		await conn.run(sql`CREATE TRIGGER search_documents_fts_insert AFTER INSERT ON search_documents BEGIN
			INSERT INTO search_documents_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
		END`);
		await conn.run(sql`CREATE TRIGGER search_documents_fts_delete AFTER DELETE ON search_documents BEGIN
			INSERT INTO search_documents_fts(search_documents_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
		END`);
		await conn.run(sql`CREATE TRIGGER search_documents_fts_update AFTER UPDATE ON search_documents BEGIN
			INSERT INTO search_documents_fts(search_documents_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
			INSERT INTO search_documents_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
		END`);
		await conn.run(sql`INSERT INTO search_documents_fts(search_documents_fts) VALUES ('rebuild')`);
	}
};