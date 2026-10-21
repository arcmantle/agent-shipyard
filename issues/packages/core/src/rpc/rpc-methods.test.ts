import { describe, expect, it } from "vitest";

import type { QueryEntitiesInput } from "../features/entity-store/store-types.js";
import type { SearchRequest } from "../features/storage-driver/search-store.js";
import type { StorageDriver } from "../features/storage-driver/storage-driver.js";
import { rpcMethods } from "./rpc-methods.js";

describe("workspace retrieval context RPC transport", () => {
	it("forwards privacy-safe context for search and entity queries", async () => {
		const retrievalContext = {
			repositoryIdentity: "repository-digest",
			commitSha: "commit-sha",
			calculatedVersion: "1.2.3",
			diagnostics: [{ code: "prospector-calculation-failed" as const, message: "Calculation is unavailable." }]
		};
		const searchInput: SearchRequest = { query: "workspace", scope: { type: "all-projects" }, retrievalContext };
		const queryEntitiesInput: QueryEntitiesInput = { kind: "issue", retrievalContext };
		let receivedSearchInput: SearchRequest | undefined;
		let receivedQueryEntitiesInput: QueryEntitiesInput | undefined;
		const store = {
			search: async (input: SearchRequest) => {
				receivedSearchInput = input;
				return { state: "available" as const, results: [] };
			},
			queryEntities: async (input: QueryEntitiesInput) => {
				receivedQueryEntitiesInput = input;
				return { entities: [], total: 0 };
			}
		} as unknown as StorageDriver;

		await rpcMethods.search(store, searchInput);
		await rpcMethods.queryEntities(store, queryEntitiesInput);

		expect(receivedSearchInput).toBe(searchInput);
		expect(receivedQueryEntitiesInput).toBe(queryEntitiesInput);
	});
});