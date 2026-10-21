import { describe, expect, it } from "vitest";

import { parseSearchQuery } from "./search-query.js";

describe("parseSearchQuery", () => {
	it("parses a normal question as an implicit-AND query", () => {
		expect(parseSearchQuery("Where is the SearchStore defined?")).toEqual({
			ok: true,
			query: {
				source: "Where is the SearchStore defined?",
				expression: {
					type: "and",
					operands: [
						{ type: "term", value: "searchstore", expansion: "fuzzy" },
						{ type: "term", value: "defined", expansion: "fuzzy" }
					]
				}
			}
		});
	});

	it("parses a quoted phrase as a strict expression", () => {
		expect(parseSearchQuery('"Storage Driver"')).toEqual({
			ok: true,
			query: {
				source: '"Storage Driver"',
				expression: { type: "phrase", value: "storage driver", expansion: "strict" }
			}
		});
	});

	it("binds adjacent terms more tightly than OR", () => {
		expect(parseSearchQuery("storage OR query parser")).toEqual({
			ok: true,
			query: {
				source: "storage OR query parser",
				expression: {
					type: "or",
					operands: [
						{ type: "term", value: "storage", expansion: "fuzzy" },
						{
							type: "and",
							operands: [
								{ type: "term", value: "query", expansion: "fuzzy" },
								{ type: "term", value: "parser", expansion: "fuzzy" }
							]
						}
					]
				}
			}
		});
	});

	it("parses a trailing star as a strict prefix", () => {
		expect(parseSearchQuery("stor*")).toEqual({
			ok: true,
			query: {
				source: "stor*",
				expression: { type: "prefix", value: "stor", expansion: "strict" }
			}
		});
	});

	it("binds NOT before AND and supports parenthesized expressions", () => {
		expect(parseSearchQuery('NOT storage OR (driver AND "search contract")')).toEqual({
			ok: true,
			query: {
				source: 'NOT storage OR (driver AND "search contract")',
				expression: {
					type: "or",
					operands: [
						{
							type: "not",
							operand: { type: "term", value: "storage", expansion: "strict" }
						},
						{
							type: "and",
							operands: [
								{ type: "term", value: "driver", expansion: "fuzzy" },
								{ type: "phrase", value: "search contract", expansion: "strict" }
							]
						}
					]
				}
			}
		});
	});

	it("parses NEAR operands as strict expressions with a default distance", () => {
		expect(parseSearchQuery('"storage driver" NEAR query')).toEqual({
			ok: true,
			query: {
				source: '"storage driver" NEAR query',
				expression: {
					type: "near",
					left: { type: "phrase", value: "storage driver", expansion: "strict" },
					right: { type: "term", value: "query", expansion: "strict" },
					distance: 10
				}
			}
		});
	});

	it("accepts an explicit NEAR distance", () => {
		expect(parseSearchQuery("storage NEAR/5 query")).toEqual({
			ok: true,
			query: {
				source: "storage NEAR/5 query",
				expression: {
					type: "near",
					left: { type: "term", value: "storage", expansion: "strict" },
					right: { type: "term", value: "query", expansion: "strict" },
					distance: 5
				}
			}
		});
	});

	it("reports the position of an unterminated phrase", () => {
		expect(parseSearchQuery('"storage driver')).toEqual({
			ok: false,
			error: { message: "Expected a closing quote.", start: 0, end: 15 }
		});
	});

	it("normalizes Latin diacritics and common reference separators", () => {
		expect(parseSearchQuery("ISS_ABC-123 Caf\u00e9")).toEqual({
			ok: true,
			query: {
				source: "ISS_ABC-123 Caf\u00e9",
				expression: {
					type: "and",
					operands: [
						{ type: "term", value: "issabc123", expansion: "fuzzy" },
						{ type: "term", value: "cafe", expansion: "fuzzy" }
					]
				}
			}
		});
	});

	it("supports a leading minus as strict exclusion shorthand", () => {
		expect(parseSearchQuery("storage -draft")).toEqual({
			ok: true,
			query: {
				source: "storage -draft",
				expression: {
					type: "and",
					operands: [
						{ type: "term", value: "storage", expansion: "fuzzy" },
						{
							type: "not",
							operand: { type: "term", value: "draft", expansion: "strict" }
						}
					]
				}
			}
		});
	});

	it("validates explicit NEAR distances at their source position", () => {
		expect(parseSearchQuery("storage NEAR/0 driver")).toEqual({
			ok: false,
			error: { message: "NEAR distance must be an integer from 1 through 100.", start: 13, end: 14 }
		});
	});

	it("reports a non-numeric NEAR distance at the invalid text", () => {
		expect(parseSearchQuery("storage NEAR/five driver")).toEqual({
			ok: false,
			error: { message: "NEAR distance must be an integer from 1 through 100.", start: 13, end: 17 }
		});
	});

	it("reports a trailing operator at the end of the query", () => {
		expect(parseSearchQuery("storage OR")).toEqual({
			ok: false,
			error: { message: "Expected a search term.", start: 10, end: 10 }
		});
	});
});