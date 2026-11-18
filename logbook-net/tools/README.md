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

## Differ

Compares a candidate (.NET) implementation with the recorded TypeScript results. Both modes use one code path (`src/differ.ts`); only the source of the expectation differs.

```sh
cd logbook-net/tools
bun src/parity.ts check --candidate-cli "<command>" --candidate-url <url> [case-id-glob ...]   # golden files; no TypeScript needed
bun src/parity.ts diff  --candidate-cli "<command>" --candidate-url <url> [case-id-glob ...]   # live TypeScript run; local investigation
```

Options: `--candidate-token` (omit for no-auth mode), `--candidate-tenant` (default: a new tenant for each case), `--rules <file>`, `--fail-on-unused`. The candidate runs through the recorder, so it gets the same clean environment and normalization as the recording.

- A case passes only when the candidate observation equals the expected one. Each difference is listed with its JSON Pointer. Array order, JSON type, literal content hashes, HTTP status, exit code, stdout, stderr, and `null` versus absent all count. Object key order does not.
- A candidate that fails to run (exit code other than the case expects, output that is not the declared kind, timeout, no server) is reported as `ERROR` for that case. The other cases still run. The tool exits with a non-zero code when any case does not pass.
- `diff` needs the same setup as the recorder (built `logbook/` packages and PostgreSQL).

### Intended differences

`contract/intended-differences.json` holds the approved differences. A rule has `id`, `cases` (glob), `path` (JSON Pointer to one string), `action` (`rewrite` or `remove-line`), `match` (regular expression), `replace` (rewrite only), and `reason`.

- A rule changes the legacy expectation only. The candidate is never changed, so a rule cannot approve a candidate defect. Rules touch string values only, so they cannot hide a status, exit code, type, or `null` difference.
- Rules must be narrow. The tool rejects a rule when the `cases` glob does not name a surface and part of a case name (`cli/*` is rejected, `cli/*-help` is allowed), the path is not a pointer to one value, or the `match` pattern matches common text such as an empty string, a space, or one letter.
- The report lists the cases that each rule changed. A rule that changed no case is reported as `UNUSED` (only when all cases ran); `--fail-on-unused` makes that a failure.

A rule must not change a retained input. The tool rejects a rule when it rewrites, or removes a line with, any of the four `agent-issues/.../v1` stable-ID namespaces, `.agent-issues.json`, `.agent-issues`, or `AGENT_ISSUES_PROJECT_IDENTITY` (`src/rename.ts` lists them). The check tries each name alone and inside common text, so a lookahead such as `agent-issues(?= )` fails and `(?<![.\w/-])agent-issues(?= )` passes.

### Rename and removal rules

The rename is one mechanical rule for each case form (`agent-issues`, `agentIssues`, `AGENT_ISSUES`, `agent_issues`, `AgentIssues`, `Agent Issues`). `renameVisible` in `src/rename.ts` applies it and keeps the retained inputs. Text rules in `intended-differences.json` express a rename for each recorded case. A rename of a route, header, resource URI, or key has a test in `src/surfaces.test.ts` and gets a text rule when its owning feature adds a case.

`contract/surface-rules.json` lists the approved removals, each with its Plan entry and reason. A removal names one exact surface: a command ID (`cli:daemon`), a route (`POST /daemon/stop`), a legacy name (environment variable, header, file, credential, alias, JSON-RPC method), or a component path. A wildcard is rejected, a command or route must exist in `contract/inventory.json`, and no removal may overlap a retained input. A removed command does not remove its sub-commands, and `exportCanonicalChains` and `importCanonicalChains` stay.

```sh
cd logbook-net/tools
bun src/surfaces.ts          # check the rules, print the counts
bun src/surfaces.ts --list   # one line for each inventory surface
```

Each inventory surface has one status: `removed` (an approved removal), `covered` (a case drives it), or `not-yet-ported` (no case yet). A later feature slice adds its cases before it claims completion.

Limits: values are compared after `JSON.parse`, so `1` and `1.0` are equal and integers above 2^53 lose precision. `-0` and `0` differ. `--candidate-tenant` makes all cases share one tenant, so data can carry over between cases.
