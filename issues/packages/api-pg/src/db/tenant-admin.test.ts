import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./connection.js";
import { cleanupTestTenants, createTestTenantId } from "./test-tenant-cleanup.js";
import { PgStore } from "../pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced in tests (Postgres superusers bypass
// RLS unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

// RLS (ADR9) makes every PgStore instance's own tenant the only one it can
// ever see or touch, so - unlike SqliteStore's single-file, cross-tenant
// admin view - these methods only ever report on or act on `this.tenantId`.
describe("tenant administration", () => {
	let adminPool: Pool;
	let appPool: Pool;
	let databasePool: Pool;
	const schemaName = `tenant_admin_${randomUUID().replace(/-/g, "_")}`;
	const schemaOptions = `-c search_path=${schemaName}`;

	beforeAll(async () => {
		databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await databasePool.query(`CREATE SCHEMA ${schemaName}`);
		adminPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: schemaOptions });
		await migratePgDatabase(adminPool);
		await databasePool.query(`GRANT USAGE ON SCHEMA ${schemaName} TO agent_issues_app`);
		await databasePool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaName} TO agent_issues_app`);
		appPool = new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions });
	});

	afterAll(async () => {
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
		await databasePool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		await databasePool.end();
	});

	it("reports no tenants until the tenant has rows, then its own summary", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		expect(await store.listTenants()).toEqual([]);

		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.updateEntity({ entityId: initiative.id, body: "Current", expectedRevision: initiative.revision, expectedContentHash: initiative.contentHash });

		const tenants = await store.listTenants();
		const snapshot = await store.getDatabaseSnapshot();
		expect(tenants).toHaveLength(1);
		expect(tenants[0]?.id).toBe(tenantId);
		expect(tenants[0]?.counts.entities).toBeGreaterThan(0);
		expect(tenants[0]?.counts.historyEntries).toBe(snapshot.entities.reduce((total, entity) => total + entity.revision, 0));
	});

	it("never lists a sibling tenant's summary", async () => {
		const tenantA = createTestTenantId();
		const tenantB = createTestTenantId();
		const storeA = new PgStore(appPool, tenantA);
		const storeB = new PgStore(appPool, tenantB);

		await storeA.createEntity({ kind: "initiative", title: "Tenant A's initiative" });
		await storeB.createEntity({ kind: "initiative", title: "Tenant B's initiative" });

		expect((await storeA.listTenants()).map((tenant) => tenant.id)).toEqual([tenantA]);
		expect((await storeB.listTenants()).map((tenant) => tenant.id)).toEqual([tenantB]);
	});

	it("deletes the tenant's own data and reports what was removed", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "Canonical order." });
		await store.createEntity({ kind: "handoff", title: "Handoff", links: [{ relationType: "handsOff", targetId: initiative.id }] });

		const result = await store.deleteTenant(tenantId);

		expect(result.removed).toBe(true);
		expect(result.counts.entities).toBeGreaterThan(0);
		expect(result.counts.contextTerms).toBe(1);
		expect(await store.listTenants()).toEqual([]);
		await expect(store.getEntityDetails(initiative.id)).rejects.toThrow();
	});

	it("rejects deleting a different tenant", async () => {
		const tenantId = createTestTenantId();
		const otherTenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		await expect(store.deleteTenant(otherTenantId)).rejects.toThrow(/own tenant/);
	});

	it("renames the tenant, moving entities, contexts, and graph handoffs to the new id", async () => {
		const previousTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, previousTenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.setEntityBody({ entityId: initiative.id, body: "Current body.", expectedRevision: initiative.revision, expectedContentHash: initiative.contentHash });
		const contextV1 = await store.upsertContext({ scopeRef: initiative.id, title: "Payments terms", summary: "Initial summary." });
		await store.upsertContext({ scopeRef: initiative.id, title: "Payments language", summary: "Current summary.", expectedRevision: contextV1.context.revision, expectedContentHash: contextV1.context.contentHash });
		const termV1 = await store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "Initial order." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "Canonical order.", expectedRevision: termV1.term.revision, expectedContentHash: termV1.term.contentHash });
		const handoff = await store.createEntity({ kind: "handoff", title: "Handoff", links: [{ relationType: "handsOff", targetId: initiative.id }] });

		const result = await store.renameTenant(previousTenantId, newTenantId);

		expect(result.renamed).toBe(true);
		expect(result.newTenantId).toBe(newTenantId);
		expect(result.previousTenantId).toBe(previousTenantId);

		const renamedStore = new PgStore(appPool, newTenantId);
		const details = await renamedStore.getEntityDetails(initiative.id);
		expect(details.entity).toMatchObject({ title: "Payments", body: "Current body.", revision: 2 });
		expect(await renamedStore.materializeEntityRevision({ entityId: initiative.id, revision: 1 })).toMatchObject({ body: "", title: "Payments" });
		const context = await renamedStore.getContextDetails({ scopeRef: initiative.id });
		expect(context.context).toMatchObject({ title: "Payments language", summary: "Current summary.", revision: 2 });
		expect(context.terms).toEqual([expect.objectContaining({ term: "Order", definition: "Canonical order.", revision: 2 })]);
		expect(await renamedStore.materializeContextRevision({ scopeRef: initiative.id, revision: 1 })).toMatchObject({ title: "Payments terms", summary: "Initial summary." });
		expect(await renamedStore.materializeContextTermRevision({ scopeRef: initiative.id, term: "Order", revision: 1 })).toMatchObject({ definition: "Initial order." });
		const handoffDetails = await renamedStore.getEntityDetails(handoff.id);
		expect(handoffDetails.outgoing).toEqual(expect.arrayContaining([
			expect.objectContaining({ relationType: "handsOff", entity: expect.objectContaining({ id: initiative.id }) })
		]));

		expect(await store.listTenants()).toEqual([]);
	});

	it("returns renamed:false without changing anything when the tenant has no rows", async () => {
		const previousTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, previousTenantId);

		const result = await store.renameTenant(previousTenantId, newTenantId);

		expect(result.renamed).toBe(false);
		expect(await new PgStore(appPool, newTenantId).listTenants()).toEqual([]);
	});

	it("rejects renaming a different tenant", async () => {
		const tenantId = createTestTenantId();
		const otherTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		await expect(store.renameTenant(otherTenantId, newTenantId)).rejects.toThrow(/own tenant/);
	});

	it("rejects renaming a tenant onto itself", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		await expect(store.renameTenant(tenantId, tenantId)).rejects.toThrow(/same/);
	});

	it("rejects renaming onto a tenant that already has rows", async () => {
		const previousTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, previousTenantId);
		await store.createEntity({ kind: "initiative", title: "Payments" });
		const targetStore = new PgStore(appPool, newTenantId);
		await targetStore.createEntity({ kind: "initiative", title: "Already here" });

		await expect(store.renameTenant(previousTenantId, newTenantId)).rejects.toThrow(/already exists/);
	});
});
