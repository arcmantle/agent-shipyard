import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

// Every Postgres-backed test that needs its own throwaway tenant goes
// through this instead of minting `tenant-${randomUUID()}` directly, so
// `cleanupTestTenants` can delete every row a test run created without
// requiring per-test `afterEach` wiring at each call site. Tests against the
// real local Postgres instance (the same one the docker-compose dev stack
// browses via CloudBeaver) must never leave rows behind - see ISS61.
const trackedTenantIds = new Set<string>();

export function createTestTenantId(): string {
	const tenantId = `tenant-${randomUUID()}`;
	trackedTenantIds.add(tenantId);
	return tenantId;
}

/**
 * Direct-SQL teardown mirroring `PgStore.deleteTenant`'s table order and
 * cascade, but deliberately bypassing its same-tenant-only guard
 * (`requireOwnTenant`) - tests need a single admin-role pool to delete every
 * tenant id a run created in bulk, not one `PgStore` instance per tenant.
 * Safe to call from every file's `afterAll`, even ones that created zero
 * tenants (a no-op when nothing is tracked) or share tracked ids with other
 * files in the same test run (each id is only ever deleted once).
 */
export async function cleanupTestTenants(pool: Pool): Promise<void> {
	if (trackedTenantIds.size === 0) {
		return;
	}

	const tenantIds = [...trackedTenantIds];
	trackedTenantIds.clear();

	await pool.query(`DELETE FROM instruction_history WHERE tenant_id = ANY($1)`, [tenantIds]);
	await pool.query(`DELETE FROM revision_entries WHERE tenant_id = ANY($1)`, [tenantIds]);
	await pool.query(`DELETE FROM context_terms WHERE tenant_id = ANY($1)`, [tenantIds]);
	await pool.query(`DELETE FROM relations WHERE tenant_id = ANY($1)`, [tenantIds]);
	await pool.query(`DELETE FROM contexts WHERE tenant_id = ANY($1)`, [tenantIds]);
	await pool.query(`DELETE FROM entities WHERE tenant_id = ANY($1)`, [tenantIds]);
	await pool.query(`DELETE FROM counters WHERE tenant_id = ANY($1)`, [tenantIds]);
}
