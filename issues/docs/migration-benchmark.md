# Migration benchmark

This is a review summary of the migration routes. The executable thresholds live in `MIGRATION_BENCHMARK`. SQLite backup and transform counts are asserted in the local schema-migration tests. Postgres statement counts are asserted by the instrumented direct-route test. Wall-clock timing is intentionally excluded from CI because it is machine-dependent.

## Route cost

| Route | Backups | Legacy transforms |
| --- | ---: | ---: |
| SQLite fresh | 0 | 0 |
| SQLite current-final | 0 | 0 |
| SQLite legacy v7 | 1 | 1 |

The SQLite legacy backup test also requires the copied file to have exactly the pre-upgrade byte size. Fresh and current-final routes never copy a backup or run the legacy transformer. Legacy routes create only final tables: tests reject transitional delta, alias, historical-ledger, and retained `legacy_v7_*` tables.

| Postgres route | Statements |
| --- | ---: |
| Postgres legacy v7, 1 fixture copy | 228 |
| Postgres legacy v7, 2 fixture copies | 228 |

Before contraction, production replayed 26 sequential migration modules. No trustworthy statement-level baseline was recorded before that implementation was replaced, so this document does not invent one. The current value of 228 is observed by wrapping the migration pool's checked-out client and counting every `client.query()` invocation from classification through commit. The same instrumented route observes 228 statements when fixture entities and revisions double, demonstrating the intended reduction from row-scaled query sequences to a fixed set-based route.

## Behavioral parity

The adapter suites compose the regression wall:

- SQLite `schema-migration.test.ts` proves exact final schema, golden-fixture row preservation, direct routing, no transitional tables, history-chain reconstruction, tenant mapping, and one exact legacy backup.
- Postgres `migrations/index.test.ts` proves exact final schema, row and revision-chain preservation, historical materialization, tenant isolation, direct routing, and bounded statement count.
- Both storage-driver contract suites prove migrated data remains usable through the shared storage-driver seam.
- The shared synchronization suite proves projects still export and import canonical rows and revision chains across storage-driver instances.

Rows transformed and chains preserved are asserted from fixture contents rather than logged as timing output: the golden SQLite fixture checks every source row and reconstructed revision; the scalable Postgres fixture checks one project, initiative, issue, two relations, and two historical revisions per copy.

## Postgres rewrite and lock review

The direct route renames each legacy table, creates the final tables and indexes, configures and forces RLS policies, performs set-based inserts, then drops retained legacy tables. PostgreSQL takes `ACCESS EXCLUSIVE` locks for table renames and drops; final-schema DDL, index creation, and RLS policy changes also acquire table locks and extend the transaction's blocking window. These are the major blocking operations to review for any future route; ordinary inserts do not rewrite existing final tables. The whole classification and transform runs on one client under one database/schema advisory lock and transaction.