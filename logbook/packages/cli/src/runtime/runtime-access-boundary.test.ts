import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { findRuntimeAccessBoundaryViolations } from "./runtime-access-boundary.js";

let fixtureRoot: string | null = null;

function writeFixture(relativePath: string, source: string): string {
	fixtureRoot ??= mkdtempSync(path.join(tmpdir(), "agent-issues-runtime-boundary-"));
	const filePath = path.join(fixtureRoot, relativePath);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, source);
	return fixtureRoot;
}

afterEach(() => {
	if (fixtureRoot) {
		rmSync(fixtureRoot, { force: true, recursive: true });
		fixtureRoot = null;
	}
});

describe("Drizzle runtime access boundary", () => {
	it("reports direct pg queries in a runtime feature store", () => {
		const root = writeFixture(
			"api-pg/src/features/widgets/widget-store.ts",
			[
				'import type { Pool } from "pg";',
				"",
				"export async function loadWidgets(pool: Pool) {",
				'\treturn pool.query("SELECT * FROM widgets");',
				"}",
				""
			].join("\n")
		);

		expect(findRuntimeAccessBoundaryViolations(root)).toEqual([
			{
				file: "api-pg/src/features/widgets/widget-store.ts",
				line: 4,
				driver: "pg",
				method: "query"
			}
		]);
	});

	it("reports direct better-sqlite3 calls in a runtime feature store", () => {
		const root = writeFixture(
			"api-local/src/features/widgets/widget-store.ts",
			[
				'import type Database from "better-sqlite3";',
				"",
				"export function loadWidgets(db: Database.Database) {",
				'\treturn db.prepare("SELECT * FROM widgets").all();',
				"}",
				""
			].join("\n")
		);

		expect(findRuntimeAccessBoundaryViolations(root)).toEqual([
			{
				file: "api-local/src/features/widgets/widget-store.ts",
				line: 1,
				driver: "better-sqlite3",
				method: "import"
			},
			{
				file: "api-local/src/features/widgets/widget-store.ts",
				line: 4,
				driver: "better-sqlite3",
				method: "prepare"
			}
		]);
	});

	it("reports native better-sqlite3 construction outside the private adapter", () => {
		const root = writeFixture(
			"api-local/src/db/source-profile.ts",
			[
				'import Database from "better-sqlite3";',
				"",
				"export function open(path: string) {",
				"\tconst db = new Database(path);",
				"\treturn db;",
				"}",
				""
			].join("\n")
		);

		expect(findRuntimeAccessBoundaryViolations(root)).toEqual([
			{
				file: "api-local/src/db/source-profile.ts",
				line: 1,
				driver: "better-sqlite3",
				method: "import"
			},
			{
				file: "api-local/src/db/source-profile.ts",
				line: 4,
				driver: "better-sqlite3",
				method: "construct"
			}
		]);
	});

	it("reports escape-hatch property access and all raw sqlite wrapper calls", () => {
		const root = writeFixture(
			"api-local/src/features/widgets/widget-store.ts",
			[
				"type SqliteLike = { db: unknown; identityToken: object; pragma(q: string): unknown; exec(q: string): void; transaction<T>(fn: () => T): T; get(q: string): unknown; run(q: string): unknown; all(q: string): unknown[]; };",
				"",
				"export function inspect(connection: SqliteLike) {",
				"\tvoid connection.db;",
				"\tvoid connection.identityToken;",
				"\tconnection.pragma('foreign_keys = ON');",
				"\tconnection.exec('BEGIN');",
				"\tconnection.transaction(() => connection.run('SELECT 1'));",
				"\tconnection.get('SELECT 1');",
				"\tconnection.all('SELECT 1');",
				"}",
				""
			].join("\n")
		);

		expect(findRuntimeAccessBoundaryViolations(root)).toEqual([
			{ file: "api-local/src/features/widgets/widget-store.ts", line: 4, driver: "better-sqlite3", method: "db" },
			{ file: "api-local/src/features/widgets/widget-store.ts", line: 5, driver: "better-sqlite3", method: "identityToken" },
			{ file: "api-local/src/features/widgets/widget-store.ts", line: 6, driver: "better-sqlite3", method: "pragma" },
			{ file: "api-local/src/features/widgets/widget-store.ts", line: 7, driver: "better-sqlite3", method: "exec" },
			{ file: "api-local/src/features/widgets/widget-store.ts", line: 8, driver: "better-sqlite3", method: "transaction" },
			{ file: "api-local/src/features/widgets/widget-store.ts", line: 8, driver: "better-sqlite3", method: "run" },
			{ file: "api-local/src/features/widgets/widget-store.ts", line: 9, driver: "better-sqlite3", method: "get" },
			{ file: "api-local/src/features/widgets/widget-store.ts", line: 10, driver: "better-sqlite3", method: "all" }
		]);
	});

	it("does not require a direct driver import to identify a raw query call", () => {
		const root = writeFixture(
			"api-pg/src/features/widgets/widget-store.ts",
			[
				'import type { DatabaseConnection } from "../../db/connection.js";',
				"",
				"export async function loadWidgets(connection: DatabaseConnection) {",
				'\treturn connection.query("SELECT * FROM widgets");',
				"}",
				""
			].join("\n")
		);

		expect(findRuntimeAccessBoundaryViolations(root)).toEqual([
			{
				file: "api-pg/src/features/widgets/widget-store.ts",
				line: 4,
				driver: "pg",
				method: "query"
			}
		]);
	});

	it("permits documented connection and transaction infrastructure", () => {
		const root = writeFixture(
			"api-pg/src/db/connection.ts",
			[
				'import type { PoolClient } from "pg";',
				"",
				"export async function beginTenantTransaction(client: PoolClient, tenantId: string) {",
				'\tawait client.query("BEGIN");',
				'\tawait client.query("SELECT set_config(\'app.tenant_id\', $1, true)", [tenantId]);',
				"}",
				""
			].join("\n")
		);

		expect(findRuntimeAccessBoundaryViolations(root)).toEqual([]);
	});

	it("permits better-sqlite3 access only in the dedicated adapter module", () => {
		const root = writeFixture(
			"api-local/src/db/sqlite-connection.ts",
			[
				'import Database from "better-sqlite3";',
				"",
				"export function open(path: string) {",
				"\tconst db = new Database(path);",
				"\treturn db.name;",
				"}",
				""
			].join("\n")
		);

		expect(findRuntimeAccessBoundaryViolations(root)).toEqual([]);
	});

	it("keeps backend runtime source behind the Drizzle boundary", () => {
		const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));

		expect(findRuntimeAccessBoundaryViolations(repositoryRoot)).toEqual([]);
	});
});