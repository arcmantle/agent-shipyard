import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { schema } from "../schema.js";

export type SqliteConnection = {
	drizzle: BetterSQLite3Database<typeof schema>;
	tenantId: string;
	currentProjectId: string;
	dbPath: string;
	name: string;
	close(): void;
};

export type OpenSqliteConnectionOptions = {
	readonly?: boolean;
	fileMustExist?: boolean;
};

export function openSqliteConnection(dbPath: string, options?: OpenSqliteConnectionOptions): SqliteConnection {
	const sqliteClient = new Database(dbPath, options);
	const drizzleDatabase = drizzle(sqliteClient, { schema });

	return {
		drizzle: drizzleDatabase,
		tenantId: "",
		currentProjectId: "",
		dbPath,
		name: sqliteClient.name,
		close(): void {
			sqliteClient.close();
		}
	};
}