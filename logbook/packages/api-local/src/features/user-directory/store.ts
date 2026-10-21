import { sql } from "drizzle-orm";

import { deriveUserIdentity, type UserDirectoryRecord, type UserDirectoryStore } from "@agent-issues/core";

import type { SqliteExecutor } from "../../db/sqlite-executor.js";

type UserRow = {
	id: string;
	authentication_subject: string;
	display_name: string | null;
	updated_at: string;
};

export class LocalUserDirectoryStore implements UserDirectoryStore {
	public constructor(executor: SqliteExecutor) {
		this.executor = executor;
	}

	protected readonly executor: SqliteExecutor;

	public async upsertUser(input: { authenticationSubject: string; displayName?: string | null }): Promise<UserDirectoryRecord> {
		return upsertUser(this.executor, input);
	}

	public async listUsers(): Promise<UserDirectoryRecord[]> {
		return listUsers(this.executor);
	}
}

export function listUsers(executor: SqliteExecutor): UserDirectoryRecord[] {
	const rows = executor.drizzle.all(sql`SELECT id, authentication_subject, display_name, updated_at FROM users WHERE tenant_id=${executor.tenantId} ORDER BY id`) as UserRow[];
	return rows.map(toUserDirectoryRecord);
}

export function upsertUser(executor: SqliteExecutor, input: { authenticationSubject: string; displayName?: string | null }): UserDirectoryRecord {
	const identity = deriveUserIdentity(input.authenticationSubject);
	const existing = executor.drizzle.all(sql`SELECT id, authentication_subject, display_name, updated_at FROM users WHERE tenant_id=${executor.tenantId} AND id=${identity.id}`)[0] as UserRow | undefined;
	const displayName = normalizeDisplayName(input.displayName);
	if (existing) {
		if (displayName !== null && displayName !== existing.display_name) {
			const updatedAt = new Date().toISOString();
			executor.drizzle.run(sql`UPDATE users SET display_name=${displayName}, updated_at=${updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${identity.id}`);
			return { ...identity, displayName, updatedAt };
		}
		return toUserDirectoryRecord(existing);
	}

	const now = new Date().toISOString();
	executor.drizzle.run(sql`INSERT INTO users (tenant_id, id, authentication_subject, display_name, created_at, updated_at) VALUES (${executor.tenantId}, ${identity.id}, ${identity.authenticationSubject}, ${displayName}, ${now}, ${now})`);
	return { ...identity, displayName, updatedAt: now };
}

function normalizeDisplayName(displayName: string | null | undefined): string | null {
	return displayName?.trim() || null;
}

function toUserDirectoryRecord(row: UserRow): UserDirectoryRecord {
	return {
		id: row.id,
		authenticationSubject: row.authentication_subject,
		displayName: row.display_name,
		updatedAt: row.updated_at
	};
}