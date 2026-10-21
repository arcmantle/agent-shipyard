# SQLite Search Benchmark

Run the repeatable benchmark from the repository root:

```sh
pnpm --filter @agent-issues/api-local benchmark:search
```

The default fixture creates 100 Search documents in each of two projects. Set `SEARCH_BENCHMARK_RECORDS_PER_PROJECT` and `SEARCH_BENCHMARK_QUERIES` to run a larger fixture. The benchmark measures current-project and tenant-wide token search, tenant-wide typo search, one searchable-record mutation, and one canonical-import rebuild.

The command reports SQLite `dbstat` page bytes for these separate components:

- Search documents
- Token FTS5
- Trigram FTS5
- Typo vocabulary and its document membership

## Baseline

The 2026-08-28 default-fixture run produced these values on the local development machine:

| Measurement | Average | P95 |
| --- | ---: | ---: |
| Current-project token query | 2.23 ms | 3.46 ms |
| Tenant-wide token query | 2.13 ms | 3.09 ms |
| Tenant-wide typo query | 1.84 ms | 2.59 ms |
| Searchable-record mutation | 67.58 ms | 67.58 ms |
| Canonical-import rebuild | 81.46 ms | 81.46 ms |

The fixture used 131,072 bytes for Search documents, 45,056 bytes for token FTS5, 176,128 bytes for trigram FTS5, and 229,376 bytes for the Typo vocabulary.

The current settings keep at most 100 candidates across search paths and return at most 20 results. Typo checks allow one edit for terms with 4 through 7 characters and two edits for terms with 8 or more characters. Keep these settings until a representative benchmark shows a relevance or latency problem.

Use the simple in-process Typo-vocabulary scan at the current corpus size. Evaluate an in-process vocabulary index only when the tenant-wide typo query p95 exceeds 10 ms in three comparable benchmark runs and the vocabulary contains more than 50,000 distinct terms. Do not add a separate search service for this threshold.

Search diagnostics contain duration, per-path candidate counts, result count, capability state, and an error category. They do not contain query text or result content.
