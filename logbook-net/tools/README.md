# Migration tools

## Test-vector exporter

`test-vectors.ts` runs the real TypeScript pure functions in `logbook/packages` with Bun. It writes exact inputs and expected outputs to `logbook-net/contract/test-vectors/`.

```sh
bun logbook-net/tools/test-vectors.ts          # write the vector files
bun logbook-net/tools/test-vectors.ts --check  # fail if the files differ from a fresh export
bun test logbook-net/tools                     # export, determinism, and mutation checks
```

Groups: `namespaces`, `stable-ids`, `references`, `content-hashes`, `reverse-patches`, `record-keys`, `project-identity`.

- Each vector has `name`, `behavior`, `input`, and `expected` (`{ "value": ... }` or `{ "error": "message" }`).
- Expected values are literal. Derivation outputs are never normalized.
- Binary data (reverse patches) is lower-case hex.
- The four stable-ID namespaces keep their `agent-issues/...` values. The export fails if the TypeScript source stops deriving from them.
- The project-identity vectors cover the legacy inputs only (environment variable, `.agent-issues.json`, `.agent-issues`, Git origin, package name, folder name). The new `.agent-shipyard` inputs have no TypeScript source to export.
- Project-identity vectors run the real resolver source. Only its two imports are supplied by the tool, so no database driver is installed.

Limits:
- Expected values come from the TypeScript source, so a comparison detects drift from that source, not a wrong original value. Only the four namespaces and the reference and short-reference literals of this tracker are checked independently.
- Random `generate*` functions, `mergeUserDirectories`, `deriveEntityKindFromId`, and `archiveHeadContentHash` have no vectors yet.

## Parity recorder

A Bun and TypeScript tool that records repeatable results from the TypeScript Logbook implementation.

### Record golden files

Build the TypeScript packages in `logbook/` first (`core`, `api-local`, `api-pg`, `site`, `agent-issues`).
PostgreSQL must run on `127.0.0.1:5433`, or set `AGENT_ISSUES_TEST_PG_URL` and `AGENT_ISSUES_TEST_PG_APP_URL`.

```sh
cd logbook-net/tools
bun src/record.ts [case-id-glob ...]
bun test
```

Cases are `contract/cases/<surface>/<name>.case.json`. Golden files are `contract/golden/<surface>/<name>.golden.json`.

### Case format

CLI case: `id`, `surface: "cli"`, `workspace` (`folder`, optional `files` map), `argv`, `stdout` (`"json"` or `"text"`), optional `expectExitCode` (default 0).

RPC case: `id`, `surface: "rpc"`, `steps`. A step has `method`, optional `params`, optional `as` (name for later `${name.field}` substitution), and optional `expectError: true` for a step that must fail. Each case uses its own tenant.

### Normalization

Only these changes are made to a recording: CRLF becomes LF, temporary paths, the tenant, timestamps, and UUIDs, references and short references become ordered placeholders (`<uuid#1>`).
Object key order is ignored. Array order, JSON types, literal content hashes and null versus absent stay distinct.

### Failures

The recorder writes no golden file when a case fails, and removes an older golden file for that case: a failed setup step, an unexpected HTTP status or JSON-RPC error, an unresolved substitution, an unexpected exit code, or output that is not the declared kind. The tool exits with a non-zero code.
