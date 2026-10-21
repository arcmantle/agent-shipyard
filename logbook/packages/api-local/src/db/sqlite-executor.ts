import { and, eq } from "drizzle-orm";

import { shortEntityReference } from "@agent-issues/core";
import { entities } from "../schema.js";
import { openSqliteConnection, type SqliteConnection } from "./sqlite-connection.js";

export type SqliteInternalConnection = SqliteConnection;

export type SqliteExecutor = Pick<
	SqliteConnection,
	"drizzle" | "tenantId" | "currentProjectId" | "dbPath" | "close"
>;

export function createSqliteExecutor(dbPath: string): SqliteInternalConnection {
	return openSqliteConnection(dbPath);
}

export function getSqliteEntityOrThrow(executor: SqliteExecutor, entityId: string) {
	const row = resolveSqliteEntity(executor, entityId);

	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return row;
}

export function resolveSqliteEntity(executor: SqliteExecutor, entityId: string, includeTombstone: boolean = false) {
	const rows = resolveSqliteEntities(executor, entityId, includeTombstone);
	if (rows.length > 1) {
		throw new Error(`Ambiguous short entity reference: ${entityId}. Use one of: ${rows.map((row) => row.reference).join(", ")}`);
	}
	return rows[0];
}

export function resolveSqliteEntities(executor: SqliteExecutor, entityId: string, includeTombstone: boolean = false) {
	const livePredicate = includeTombstone ? undefined : eq(entities.tombstone, false);
	let row = executor.drizzle
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, entityId), livePredicate))
		.get();

	if (!row) {
		row = executor.drizzle
			.select()
			.from(entities)
			.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.reference, entityId), livePredicate))
			.get();
	}

	if (row) {
		return [row];
	}

	return executor.drizzle
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.shortReference, entityId), livePredicate))
		.all();
}