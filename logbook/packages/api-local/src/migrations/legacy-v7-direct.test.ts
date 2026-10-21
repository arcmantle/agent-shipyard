import { beforeEach, describe, expect, it, vi } from "vitest";

const buildLegacySqliteV7RowsMock = vi.fn();
const finalBaselineUpMock = vi.fn();
const createSqliteMigrationConnMock = vi.fn();

vi.mock("./legacy-v7-semantic.js", () => ({
	buildLegacySqliteV7Rows: (...args: unknown[]) => buildLegacySqliteV7RowsMock(...args)
}));

vi.mock("./final-baseline.js", () => ({
	finalBaselineMigration: {
		id: "final-baseline",
		up: (...args: unknown[]) => finalBaselineUpMock(...args)
	}
}));

vi.mock("../db/migration-runner.js", () => ({
	createSqliteMigrationConn: (...args: unknown[]) => createSqliteMigrationConnMock(...args)
}));

import { transformLegacySqliteV7 } from "./legacy-v7-direct.js";

function sqlText(query: unknown): string {
	if (!query || typeof query !== "object") {
		return String(query ?? "").toUpperCase();
	}
	const queryChunks = (query as { queryChunks?: unknown[] }).queryChunks;
	if (!Array.isArray(queryChunks)) {
		return String(query).toUpperCase();
	}
	return queryChunks
		.map((chunk) => {
			if (!chunk || typeof chunk !== "object") {
				return "";
			}
			const value = (chunk as { value?: unknown }).value;
			if (Array.isArray(value)) {
				return value.join("");
			}
			if (typeof value === "string") {
				return value;
			}
			return "";
		})
		.join(" ")
		.toUpperCase();
}

function createStubDatabase(log: string[]) {
	const drizzle = {
		run(query: unknown) {
			const text = sqlText(query);
			if (text.includes("BEGIN")) {
				log.push("BEGIN");
			}
			if (text.includes("COMMIT")) {
				log.push("COMMIT");
			}
			if (text.includes("ROLLBACK")) {
				log.push("ROLLBACK");
			}
			return { changes: 0, lastInsertRowid: 0 };
		},
		all(query: unknown) {
			const text = sqlText(query);
			if (text.includes("FROM SQLITE_MASTER")) {
				return [];
			}
			return [];
		},
		get() {
			return undefined;
		}
	};

	return {
		tenantId: "fixture",
		currentProjectId: "fixture-project",
		dbPath: ":memory:",
		name: ":memory:",
		drizzle,
		close() {
			return undefined;
		}
	};
}

describe("transformLegacySqliteV7", () => {
	beforeEach(() => {
		buildLegacySqliteV7RowsMock.mockReset();
		finalBaselineUpMock.mockReset();
		createSqliteMigrationConnMock.mockReset();
		createSqliteMigrationConnMock.mockReturnValue({ dialect: "sqlite", run: vi.fn(), all: vi.fn().mockResolvedValue([]) });
		finalBaselineUpMock.mockResolvedValue(undefined);
		buildLegacySqliteV7RowsMock.mockReturnValue({
			counters: [],
			entities: [],
			relations: [],
			contexts: [],
			context_terms: [],
			revision_entries: []
		});
	});

	it("opens the transaction before semantic source reads", async () => {
		const log: string[] = [];
		buildLegacySqliteV7RowsMock.mockImplementation(() => {
			log.push("read-legacy-source");
			return {
				counters: [],
				entities: [],
				relations: [],
				contexts: [],
				context_terms: [],
				revision_entries: []
			};
		});

		await transformLegacySqliteV7(createStubDatabase(log) as never);

		expect(log.indexOf("BEGIN")).toBeGreaterThanOrEqual(0);
		expect(log.indexOf("BEGIN")).toBeLessThan(log.indexOf("read-legacy-source"));
		expect(log).toContain("COMMIT");
	});

	it("rolls back when semantic source read fails", async () => {
		const log: string[] = [];
		buildLegacySqliteV7RowsMock.mockImplementation(() => {
			throw new Error("semantic read failed");
		});

		await expect(transformLegacySqliteV7(createStubDatabase(log) as never)).rejects.toThrow("semantic read failed");
		expect(log).toEqual(expect.arrayContaining(["BEGIN", "ROLLBACK"]));
		expect(log).not.toContain("COMMIT");
	});
});
