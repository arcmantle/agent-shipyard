import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const searchTypoVocabularyMigration: Migration = {
	id: "search-typo-vocabulary",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite search typo vocabulary migration requires the SQLite dialect.");
		}

		await conn.run(sql`CREATE TABLE search_typo_vocabulary (
			tenant_id TEXT NOT NULL,
			term TEXT NOT NULL,
			PRIMARY KEY (tenant_id, term)
		)`);
		await conn.run(sql`CREATE TABLE search_typo_vocabulary_documents (
			tenant_id TEXT NOT NULL,
			term TEXT NOT NULL,
			document_rowid INTEGER NOT NULL,
			match_field TEXT NOT NULL,
			PRIMARY KEY (tenant_id, term, document_rowid, match_field),
			FOREIGN KEY (tenant_id, term) REFERENCES search_typo_vocabulary (tenant_id, term)
		)`);
		await conn.run(sql`CREATE INDEX search_typo_vocabulary_documents_document_idx
			ON search_typo_vocabulary_documents (tenant_id, document_rowid)`);
		await conn.run(sql`CREATE VIRTUAL TABLE search_documents_fts_vocabulary USING fts5vocab(search_documents_fts, 'instance')`);
		await conn.run(sql`INSERT INTO search_typo_vocabulary (tenant_id, term)
			SELECT DISTINCT document.tenant_id, vocabulary.term
			FROM search_documents_fts_vocabulary AS vocabulary
			JOIN search_documents AS document ON document.rowid = vocabulary.doc`);
		await conn.run(sql`INSERT INTO search_typo_vocabulary_documents (tenant_id, term, document_rowid, match_field)
			SELECT DISTINCT document.tenant_id, vocabulary.term, document.rowid,
				CASE
					WHEN document.source_type = 'context-term' AND vocabulary.col = 'title' THEN 'term'
					WHEN document.source_type = 'context-term' THEN 'definition'
					WHEN vocabulary.col = 'title' THEN 'title'
					ELSE 'body'
				END
			FROM search_documents_fts_vocabulary AS vocabulary
			JOIN search_documents AS document ON document.rowid = vocabulary.doc`);
		await conn.run(sql`DROP TABLE search_documents_fts_vocabulary`);
	}
};
