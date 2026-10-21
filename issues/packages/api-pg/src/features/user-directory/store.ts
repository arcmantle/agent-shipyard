import { sql } from "drizzle-orm";

import { deriveUserIdentity, type UserDirectoryRecord, type UserDirectoryStore } from "@agent-issues/core";

import type { TenantExecutor } from "../../db/connection.js";

type UserRow = {
	id: string;
	authentication_subject: string;
	display_name: string | null;
	updated_at: string;
};

export class PgUserDirectoryStore implements UserDirectoryStore {
	public constructor(executor: TenantExecutor) {
		this.executor = executor;
	}

	protected readonly executor: TenantExecutor;

	public async upsertUser(input: { authenticationSubject: string; displayName?: string | null }): Promise<UserDirectoryRecord> {
		const identity = deriveUserIdentity(input.authenticationSubject);
		const existing = (await this.executor.execute(sql`SELECT id, authentication_subject, display_name, updated_at FROM users WHERE tenant_id=${this.executor.tenantId} AND id=${identity.id}::uuid`)).rows[0] as UserRow | undefined;
		const displayName = normalizeDisplayName(input.displayName);
		if (existing) {
			if (displayName !== null && displayName !== existing.display_name) {
				const updatedAt = new Date().toISOString();
				await this.executor.execute(sql`UPDATE users SET display_name=${displayName}, updated_at=${updatedAt} WHERE tenant_id=${this.executor.tenantId} AND id=${identity.id}::uuid`);
				return { ...identity, displayName, updatedAt };
			}
			return toUserDirectoryRecord(existing);
		}

		const now = new Date().toISOString();
		await this.executor.execute(sql`INSERT INTO users (tenant_id, id, authentication_subject, display_name, created_at, updated_at) VALUES (${this.executor.tenantId}, ${identity.id}::uuid, ${identity.authenticationSubject}, ${displayName}, ${now}, ${now})`);
		return { ...identity, displayName, updatedAt: now };
	}

	public async listUsers(): Promise<UserDirectoryRecord[]> {
		const rows = (await this.executor.execute(sql`SELECT id, authentication_subject, display_name, updated_at FROM users WHERE tenant_id=${this.executor.tenantId} ORDER BY id`)).rows as UserRow[];
		return rows.map(toUserDirectoryRecord);
	}
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