# Parity tools

Bun and TypeScript tools that record repeatable results from the TypeScript Logbook implementation.

## Record golden files

Build the TypeScript packages in `logbook/` first (`core`, `api-local`, `api-pg`, `site`, `agent-issues`).
PostgreSQL must run on `127.0.0.1:5433`, or set `AGENT_ISSUES_TEST_PG_URL` and `AGENT_ISSUES_TEST_PG_APP_URL`.

```sh
cd logbook-net/tools
bun src/record.ts [case-id-glob ...]
bun test
```

Cases are `contract/cases/<surface>/<name>.case.json`. Golden files are `contract/golden/<surface>/<name>.golden.json`.

## Case format

CLI case: `id`, `surface: "cli"`, `workspace` (`folder`, optional `files` map), `argv`, `stdout` (`"json"` or `"text"`), optional `expectExitCode` (default 0).

RPC case: `id`, `surface: "rpc"`, `steps`. A step has `method`, optional `params`, optional `as` (name for later `${name.field}` substitution), and optional `expectError: true` for a step that must fail. Each case uses its own tenant.

## Normalization

Only these changes are made to a recording: CRLF becomes LF, temporary paths, the tenant, timestamps, and UUIDs, references and short references become ordered placeholders (`<uuid#1>`).
Object key order is ignored. Array order, JSON types, literal content hashes and null versus absent stay distinct.

## Failures

The recorder writes no golden file when a case fails: a failed setup step, an unexpected HTTP status or JSON-RPC error, an unresolved substitution, an unexpected exit code, or output that is not the declared kind. The tool exits with a non-zero code.
