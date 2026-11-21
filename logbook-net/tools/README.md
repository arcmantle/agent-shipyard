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

## Workflow schema exporter

`export-workflow-schema.ts` writes the embedded `workflow-schema.json` that `agent-logbook schema` serves, from `contract/golden/cli/schema-json.golden.json`, with the product rename applied. `--check` fails when the resource differs from a fresh export. Record `cli/schema-json` again first when the TypeScript schema changes.

## Parity recorder

A Bun and TypeScript tool that records repeatable results from the TypeScript Logbook implementation.

### Record golden files

Build the TypeScript packages in `logbook/` first (or set `AGENT_LOGBOOK_TS_ROOT` to another checkout that has them) (`core`, `api-local`, `api-pg`, `site`, `agent-issues`).
PostgreSQL must run on `127.0.0.1:5433`, or set `AGENT_ISSUES_TEST_PG_URL` and `AGENT_ISSUES_TEST_PG_APP_URL`.

```sh
cd logbook-net/tools
bun src/record.ts [case-id-glob ...]
bun test
```

Cases are `contract/cases/<surface>/<name>.case.json`. Golden files are `contract/golden/<surface>/<name>.golden.json`.

### Case format

CLI case: `id`, `surface: "cli"`, `workspace` (`folder`, optional `files` map), optional `setup`, `argv`, `stdout` (`"json"` or `"text"`), optional `expectExitCode` (default 0). `setup` is a list of `{ argv, as? }` commands that run first in the same home and workspace; each must exit 0 and print JSON, and `as` binds that JSON for `${name.field}` in later arguments. Only the last command is observed. A CLI error prints its JSON on stderr, so an error case has `stdout: "text"`.

A case that opens a store (`create`, `show`, `list`, ...) needs the development build of the TypeScript CLI (`pnpm --filter agent-issues build:dev`): the recorder runs it with `AGENT_ISSUES_NO_DAEMON=1`, which that build accepts only under `VITEST=true`, so the recorder sets both. A candidate CLI reaches the API host that a check starts through `AGENT_LOGBOOK_API_URL`, which the recorder passes on. Give each storage case its own `workspace.folder`: the folder name is the project identity, so the cases do not see each other's records.

RPC case: `id`, `surface: "rpc"`, `steps`. A step has `method`, optional `params`, optional `as` (name for later `${name.field}` substitution), and optional `expectError: true` for a step that must fail. Each case uses its own tenant.

MCP case: `id`, `surface: "mcp"`, `workspace`, optional `setup` (as for a CLI case), and `steps`. The recorder runs the CLI with `--mcp`, sends each step as a JSON-RPC request (the first step must be `initialize`; the recorder then sends `notifications/initialized`), and records the answers. It closes the input at the end and records the exit code, the standard output that follows, and standard error. A line on standard output that is not a JSON-RPC message fails the recording. A step has `method`, optional `params`, optional `as` (binds the response `result` for `${name.field}`), and optional filters on what is compared:

- `tools` (`tools/list` only) keeps the named tools, so a candidate that implements fewer tools still compares the tools it has. A named tool that the server does not list fails the recording.
- `pick` keeps only the listed JSON Pointers of the response `result`.
- `omit` removes the listed JSON Pointers of the `result` on both sides. Use it only for a protocol detail of the SDK version that has no behavior, and say so in the case or in the README.

Cases of the `cli` and `mcp` surfaces run the built TypeScript CLI alone. Only `rpc` cases start the TypeScript API host and need PostgreSQL. The TypeScript MCP server starts the background daemon for a tool that opens a store, which an isolated recording does not run, so MCP cases are limited to tools that answer without a store.

### Normalization

Only these changes are made to a recording: CRLF becomes LF, temporary paths, the tenant, the data store location (`<data-store>`: the SQLite file of the TypeScript CLI, the API URL that a candidate reached), timestamps, and UUIDs, references and short references become ordered placeholders (`<uuid#1>`).
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

### Checking the .NET implementation

`parity.ts check` needs an API host and a candidate CLI. The Local API host has one tenant, so cases share its data unless each case runs on empty tables. The loop that the implementation was checked with: start `agent-logbook serve` on an empty database of a non-superuser role, and for each case truncate the tables (as the database owner), then run `bun src/parity.ts check --candidate-cli "dotnet <path>/AgentLogbook.Cli.dll" --candidate-url <host url> <case id>` with `AGENT_LOGBOOK_API_URL=<host url>`.

### Coverage check and slices

`contract/slices.json` says which Port slices exist, which surfaces each slice claims, and which surfaces are explicitly not yet ported. `src/coverage.ts` joins it to `contract/inventory.json`, the cases, and `contract/surface-rules.json`:

```sh
cd logbook-net/tools
bun src/coverage.ts            # development mode
bun src/coverage.ts --release  # full-release mode
bun src/coverage.ts --list     # one line for each surface
```

Each inventory surface (CLI command, RPC method, MCP tool, the MCP tool list, UI resource, route, storage-driver group) has exactly one disposition: `removed` (an approved removal rule), `claimed` (listed in a slice), or `not-yet-ported` (listed in `notYetPorted` with a reason). A surface in no list, in two lists, or not in the inventory fails the check, so a surface cannot disappear silently.

A slice with `claimed: true` needs these cases for each surface that it claims:

- CLI command: a help case (`<command> --help` or `help <command>`), a `--json` success case when the inventory says `jsonSuccess`, an error case (non-zero `expectExitCode`), and a human output case when the inventory says `humanOutput`. `help --help` is the help case of the `help` command; `help` alone, or `help` with a word that is no command, is a case of it by its output.
- RPC method: a case that has a step with that method.
- MCP tool: a case with a `tools/call` step for it. The tool list needs a `tools/list` step. A UI resource needs a `resources/read` step for its URI.
- Website route: not claimable yet. The case format has no site surface, so a slice that ports a website route adds that surface first.
- Host route and storage-driver group: no parity case. A storage claim lists the contract tests that apply (`tests`), or `"all"`. A partial claim needs a `remainder` that says where the other tests go. The check fails when a listed test title is not in the TypeScript contract.

A slice with `claimed: false` is in development: its surfaces need no cases yet. `--release` refuses every `notYetPorted` entry, every slice that is not claimed, and every partial storage claim. Approved removals stay valid in both modes, and each has its Plan entry in `surface-rules.json`.

The walking skeleton claims only what it implements and has cases for. The output of `help`, `capabilities`, and the general help lists every command, so those three stay not yet ported until all commands are ported.

### Check the claimed slices

`check-slices.ts` is the CI-equivalent run of the claimed slices against the .NET implementation:

```sh
AGENT_LOGBOOK_LOCAL_PG_URL=postgres://<user>:<password>@127.0.0.1:<port>/<empty database> bun logbook-net/tools/check-slices.ts [--release] [--candidate-cli "<command>"]
```

It runs the coverage check, starts `agent-logbook serve` with a temporary Shipyard data folder, empties every table of the database (it must have no other use), runs each parity case on empty tables, and runs the claimed storage-driver tests through the TypeScript `HttpStore` (build `logbook/packages/core` first). It exits with a non-zero code when any step fails. `.github/workflows/logbook-net-coverage.yml` runs it on real PostgreSQL.

### Drift check

`check-drift.ts` rejects TypeScript drift in the ported golden cases. It records every case of the claimed slices from the current TypeScript implementation again (in memory) and compares each recording with its golden file by the strict comparison of the differ. It needs the same setup as the recorder (built `logbook/` packages, and PostgreSQL for rpc cases).

```sh
bun logbook-net/tools/check-drift.ts [--slice <id> ...]
```

- A case of a claimed slice is compared. A case that drives only not-yet-ported surfaces is counted but not compared. A case that no slice claims or lists (`UNOWNED`), and a golden file that no case has (`ORPHAN`), fail the check.
- A missing golden file or a failed recording is an `ERROR` and fails the check. The check applies no intended-difference rule: both sides are TypeScript results, so a rule cannot hide drift.
- The check never writes a golden file and never publishes. To accept a difference, record the case again (`bun src/record.ts <case>`) and update the .NET code in the same change or in a linked issue.
- An MCP case that drives no tool, list or resource (a handshake case) belongs to the MCP server, the owner of `mcp:tools/list`.
- `.github/workflows/logbook-net-drift.yml` runs it with read-only permissions when a change touches `logbook/`, the contract, or these tools.

### Storage-driver contract through HttpStore

`storage-driver-contract/` runs the shared TypeScript contract (`logbook/packages/core/src/features/storage-driver/storage-driver-contract.ts`) through the TypeScript `HttpStore` against a .NET API host. Only the tests that the claimed slices select in `contract/slices.json` apply; `run.ts` fails when a selected title is no longer in the contract. Build `logbook/packages/core` first.

```sh
bun logbook-net/tools/storage-driver-contract/run.ts <api-url>   # a Local API host with an empty database
```

Each store gets its own project identity (the host has one tenant), and an identity that the contract names is kept with a per-run suffix. Run it on a host with a fresh database, or the stores of an earlier run stay in it.

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
bun src/surfaces.ts          # check the rules, print the count
```

`coverage.ts` gives each inventory surface its disposition (see Coverage check and slices). A later feature slice adds its cases before it claims completion.

Limits: values are compared after `JSON.parse`, so `1` and `1.0` are equal and integers above 2^53 lose precision. `-0` and `0` differ. `--candidate-tenant` makes all cases share one tenant, so data can carry over between cases.
