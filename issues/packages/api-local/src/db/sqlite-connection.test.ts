import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("sqlite connection adapter boundary", () => {
	it("directly imports and privately constructs better-sqlite3", () => {
		const source = readFileSync(fileURLToPath(new URL("./sqlite-connection.ts", import.meta.url)), "utf8");
		expect(source).toMatch(/from\s+["']better-sqlite3["']/);
		expect(source).toMatch(/new\s+Database\s*\(/);
		expect(source).toContain("drizzle(sqliteClient, { schema })");
		expect(source).toContain("sqliteClient.close()");
	});

	it("does not expose a raw sqlite facade or escape hatches", () => {
		const source = readFileSync(fileURLToPath(new URL("./sqlite-connection.ts", import.meta.url)), "utf8");
		for (const forbidden of ["prepare(", "exec(", "pragma(", "all(", "get(", "run(", "transaction(", "identityToken", "get db(", "db:", "$client"]) {
			expect(source).not.toContain(forbidden);
		}
	});
});
