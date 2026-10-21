import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const trigramSearchMigration: Migration = {
	id: "trigram-search",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite trigram search migration requires the SQLite dialect.");
		}

		await conn.run(sql`CREATE VIRTUAL TABLE search_documents_trigram USING fts5(
			title, body,
			content = '',
			tokenize = 'trigram case_sensitive 0 remove_diacritics 1'
		)`);
		await conn.run(sql`CREATE TRIGGER search_documents_trigram_insert AFTER INSERT ON search_documents BEGIN
			INSERT INTO search_documents_trigram(rowid, title, body) VALUES (new.rowid, new.title, new.body);
		END`);
		await conn.run(sql`CREATE TRIGGER search_documents_trigram_delete AFTER DELETE ON search_documents BEGIN
			INSERT INTO search_documents_trigram(search_documents_trigram, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
		END`);
		await conn.run(sql`CREATE TRIGGER search_documents_trigram_update AFTER UPDATE ON search_documents BEGIN
			INSERT INTO search_documents_trigram(search_documents_trigram, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
			INSERT INTO search_documents_trigram(rowid, title, body) VALUES (new.rowid, new.title, new.body);
		END`);
		await conn.run(sql`INSERT INTO search_documents_trigram(rowid, title, body)
			SELECT rowid, title, body FROM search_documents`);
	}
};
