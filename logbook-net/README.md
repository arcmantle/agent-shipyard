# logbook-net

.NET 11 / C# 15 implementation of Logbook, packed as `Arcmantle.AgentLogbook` (command `agent-logbook`).

```sh
dotnet build AgentLogbook.slnx
dotnet test --solution AgentLogbook.slnx   # TUnit on Microsoft.Testing.Platform
tests/verify-packed-tool.sh                # required gate: pack, install in an isolated folder, run, uninstall
```

The package is one framework-dependent `any` tool. It has no RID-specific or Native AOT build and only the `agent-logbook` command.

Install, update, and PATH instructions: [docs/installation.md](docs/installation.md). `tests/verify-install-guide.sh` checks that guide against the pack metadata.

## project-identity

`agent-logbook project-identity [--json] [--pretty]` prints the project identity of the current workspace and the input that decided it. It reads files and environment variables only. It starts no API host and needs no database.

The first input that gives a usable name wins:

1. `AGENT_SHIPYARD_PROJECT_IDENTITY`
2. `AGENT_ISSUES_PROJECT_IDENTITY`
3. top-level `projectIdentity` in `.agent-shipyard.json`
4. `.agent-shipyard` (only when it is a file; a folder is ignored)
5. `.agent-issues.json`
6. `.agent-issues` (only when it is a file)
7. the Git `origin` repository name
8. the `package.json` name
9. the workspace folder name (`workspace` when it has no letter or digit)

The new inputs win over the old ones without a warning. A file with a UTF-8 byte order mark is read as normal text, and a file that cannot be read is skipped; the TypeScript resolver rejects the first and fails on the second. The resolver is `AgentLogbook.Core.ProjectIdentity.ProjectIdentityResolver`; the exported TypeScript vectors in `contract/test-vectors/project-identity.json` are run against it.

## help, schema, capabilities

```sh
agent-logbook                                   # general help (same as `help`)
agent-logbook help [command] [--json] [--pretty]
agent-logbook <command> --help                  # same text as `help <command>`
agent-logbook schema [--json] [--pretty]
agent-logbook capabilities [--json] [--pretty]
agent-logbook --version
```

These commands read the tool only. They start no API host and need no workspace or database.

- `help` lists the commands that this release implements. `schema` prints the workflow schema (entity kinds, status flows, relations, and the context, comment and Plan-entry records). `capabilities` prints both in one payload (`{ "help": ..., "schema": ... }`).
- Human output and JSON follow the recorded TypeScript results. The approved differences are in `contract/intended-differences.json`: the command name, no `--db` option, the Shipyard project files, and help examples that name an implemented command.
- An invalid option or argument prints one line to stderr, prints nothing to stdout, and exits 1: `agent-logbook: unknown option '--bogus' for schema. Use schema --help.` An unknown command, and a command that is not ported yet (`create`, `daemon`, ...), fails the same way. No placeholder command succeeds.
- Running `agent-logbook` with no command prints the general help and exits 0, as the TypeScript CLI does.

### Command model

`CommandCatalog` (`src/AgentLogbook.Cli/Commands`) holds the implemented commands. Each `ICliCommand` has one `CommandSpec` (summary, usage, arguments, options, examples, notes, output). The catalog builds the System.CommandLine tree from the specs, and `help` and `capabilities` read the same specs, so one registration adds a command to parsing, help, and capabilities. `CommandModel.Walk(catalog.Root)` lists every command path with its options and arguments. `CommandModelTests` compares that list with `contract/inventory.json`: an implemented command must exist there, and every inventory command that has no registered command is unported.

Add a command to `CliApp.Catalog`. Add its help cases to `contract/cases/cli`, record them, and run the parity check.

### Workflow schema data

`schema` serves `src/AgentLogbook.Core/WorkflowSchema/workflow-schema.json`, an embedded resource. It is an export of the recorded TypeScript `schema --json` result with the product rename applied:

```sh
bun logbook-net/tools/export-workflow-schema.ts          # write the resource
bun logbook-net/tools/export-workflow-schema.ts --check  # fail if it differs from the recorded result
```

The schema records name some commands that are not ported yet (`context`, `comment`, `plan-entry`). They stay in the schema because they describe the workflow records, not the commands of this release.

## Local PostgreSQL

The Local API host uses the PostgreSQL that the user supplies. `LocalPostgresSelection` picks the connection. The first place that is set decides. A variable that is set but blank is an error:

1. the environment variable `AGENT_LOGBOOK_LOCAL_PG_URL`
2. the setting `postgresUrl` in `local-api.settings.json` in the Shipyard Logbook data folder
3. the built-in default `postgres://agent_logbook:agent_logbook_dev_only@127.0.0.1:5433/agent_logbook`

The value is a `postgres://` or `postgresql://` URL with a user, a host, an optional port, and one database name. The selection never reads the production `DATABASE_URL`. A value that is not usable, or a settings file that cannot be read, is an error. It never causes a fall back to a later place. If PostgreSQL does not answer, the connection fails with that error.

`docker/compose.yaml` starts a PostgreSQL service that matches the default (development only, bound to 127.0.0.1):

```sh
docker compose -f docker/compose.yaml up -d
```

## serve

`agent-logbook serve` runs the Local API host in the foreground. It takes no options. It runs the shared `AgentLogbook.Api` host with the PostgreSQL that is selected as described above.

1. It resolves the Shipyard Logbook data folder and the PostgreSQL connection. A bad value is an error.
2. It stops with an error when `local-api.discovery.json` names a live host. It removes the file of a host that no longer runs.
3. It creates or validates the schema, then starts the API on `127.0.0.1` with a port that the OS assigns.
4. Only then it writes `local-api.discovery.json` (`url`, `port`, `processId`, `toolVersion`, `startedAt`) and prints the URL.

A start that fails prints `agent-logbook serve: the Local API host did not start. <reason>` on stderr, exits with 1, and leaves no discovery file. The host has no idle time limit. A termination signal (SIGINT, SIGTERM, SIGHUP) removes the discovery file, stops the API, and exits with 0. A host that is killed leaves its file, so a client must check `/health/ready` and the process.

| Route | Answer |
| --- | --- |
| `GET /.well-known/agent-logbook` | `{"auth":{"provider":"none","tenant":"local-<OS user name>"},"version":"<tool version>"}` |
| `GET /health/live` | `{"status":"live"}` |
| `GET /health/ready` | `{"status":"ready"}`, or 503 `{"status":"not-ready"}` when the database does not answer |

No-auth mode is not a setting. `LocalNoAuthProvider.Enable` is the only way to create it, and only the Local API host calls it. The API host refuses to listen on a non-loopback address while the provider is in use, and it reads no `ASPNETCORE_URLS` or Kestrel setting.

## Client routing and HttpStore

`AgentLogbook.Client` holds the one client of the API host. Storage requests of the CLI and the MCP server go through it; neither contains a database driver.

- `HttpStore` sends every call as one JSON-RPC 2.0 `POST /rpc`. `params` is left out when absent, and JSON `null` values stay in `params` and in results. A JSON-RPC error becomes an `RpcException` (`AgentLogbook.Core.Rpc`): its subclass follows the shape of the error `data` (entity, issue comment, Plan entry, context and context term conflicts, entity and context revision errors, completion observation conflict), and every other error is an `RpcServerException`. `ErrorData` always holds the raw `data`.
- Request headers: `Authorization: Bearer <token>` only when a token exists (the local login has none), `x-agent-logbook-project-identity`, `x-agent-logbook-workspace-root`, and `x-agent-logbook-correlation-id` when set. The build-hash and database-path headers are not ported with the removed daemon.
- Failures are explicit: `HttpStoreTransportException` (no HTTP answer), `HttpStoreStatusException` (HTTP status that is not a success, even with an RPC body), `HttpStoreProtocolException` (body is not a JSON-RPC response).
- `BackendRouter.ResolveAsync` chooses the backend of one process and only reads. `AGENT_LOGBOOK_API_URL` (absolute http or https URL) overrides the active backend for that process; it reads neither the discovery file nor saved state, and a bad value is an error, not a fall back to local. Without it, the permanent default `local login` uses the host of `local-api.discovery.json` when its process is alive and the host answers `/health/live`. No route writes the saved login selection, credentials, or the discovery file. When no host runs and the caller gives a `LocalApiLaunch`, the router starts one (see below); without a launch, `LocalApiUnavailableException` says that no host runs and to start `agent-logbook serve`.

### Automatic Local API start

The CLI and the MCP server pass `ServeLaunch.Current()` (the tool command, or `dotnet AgentLogbook.Cli.dll` when the process runs through the .NET host) to `WorkspaceStore.OpenAsync`. The first request that opens a store therefore starts the host when none runs. Commands that open no store (`project-identity`, `help`, `schema`, `capabilities`, the MCP `project_identity` tool) never start PostgreSQL or the host.

- `LocalApiStarter` runs the same `agent-logbook serve` command through `/bin/sh`, which appends the output of the host to `local-api.log` and detaches its input before it becomes the host. The host outlives the caller, keeps no link to the standard streams of the caller (the MCP server speaks protocol on them), and has no idle shutdown. The child gets `AGENT_SHIPYARD_HOME` and `AGENT_LOGBOOK_LOCAL_PG_URL` from the lookup of the caller (the second is removed from the child when the lookup has none). The shell sets INT and HUP to ignored before it becomes the host, so Ctrl-C or a closed terminal of the caller does not stop it; a termination signal (TERM) still does. The log is bounded per start: it is emptied before a start when it is larger than 256 KiB, and a running host appends to it without a further limit (the host writes one line at start).
- The caller waits until the discovery file names a live process and that host answers `/health/live`, for at most 60 seconds.
- One host only: `serve` takes `local-api.start.lock` and refuses to start while the discovery file names a live host. Callers that run at the same time each start a child; the children that lose end with exit code 1, and every caller then uses the host that won.
- Stale state: the discovery file of a dead process is ignored and `serve` replaces it. A discovery file of a live process whose host does not answer is not used and is not replaced; the caller reports that the host does not answer.
- A failed start is an error, never a success and never an endless wait: the child ended (`The Local API host did not start. The process ended with exit code N. It wrote: <last 4 KiB of this start's output on one line> (log: <path>)`), or the host was not ready in time (the unpublished child is stopped).
- Windows is not supported yet: the error says to start `agent-logbook serve`.


### host

`agent-logbook host status|stop|restart` controls the background Local API host. It takes one action and no other argument. `--json` and `--pretty` work as in other commands. A missing or unknown action is `agent-logbook host: Missing or unknown action. Usage: host <status|stop|restart>` on stderr with exit code 1 (`{"error":"..."}` with `--json`). The command is new in .NET, so it has no TypeScript case in the Parity corpus. No daemon command, token or idle setting exists.

The state comes from `local-api.discovery.json` and from the host itself. The host answers `GET /local/host` with `{"processId":<id>,"toolVersion":"<version>"}`. It is the host of the file only when that process ID equals the one in the file. Both control routes exist only in the Local API host (no-auth provider with a stop handler); a deployment has no such route.

| State | Meaning |
| --- | --- |
| `running` | The file names a live process, and that process answers as itself. |
| `stopped` | There is no discovery file. |
| `stale` | The file does not describe a running host: its process has ended, or the process runs but nothing at the URL answers as that process, or the file cannot be read. The JSON has a `reason`. |

- `status` never starts a host and never writes a file. Human output: `Local API host running at <url> (process <id>, version <version>, started <time>).`, `No Local API host is running.`, or `The Local API host state is stale. <reason>`. JSON: `command`, `action`, `state`, and for a readable file `url`, `port`, `processId`, `toolVersion`, `startedAt`, and for a stale state `reason`. Exit code 0 for `running` and `stopped`, 1 for `stale`.
- `stop` sends `POST /local/host/stop` (JSON content type, loopback host name) to the host of the file. The host answers 202, stops taking new requests, lets the active requests finish, removes its discovery file, and ends. The command waits for the process to end, at most 60 seconds, and prints `Stopped the Local API host (process <id>).` JSON adds `stoppedProcessId` and `state` `stopped`. A repeated stop, or a stale file of an ended process, changes nothing, prints `No Local API host is running.` and exits with 0. The file of an ended process stays; the next `serve` replaces it.
- `stop` and `restart` refuse, with exit code 1 and without a signal, kill or file change, when a live process holds the file but does not answer as the host (another program that reuses the process ID, or a host that hangs). The same holds when the host refuses the stop request. No process is stopped by its process ID, so an unrelated process is never killed and never adopted.
- `restart` stops the running host as `stop` does, then starts one replacement as an automatic start does: the same `agent-logbook serve` command with the Shipyard data folder and `AGENT_LOGBOOK_LOCAL_PG_URL` of the caller, and a wait of at most 60 seconds. It prints `Stopped the Local API host (process <id>). Local API host running at ...` With no running host it only starts one (`No Local API host was running. ...`). If the replacement does not start, the error is the one of an automatic start and the old host is already gone. JSON: the new host as in `status`, plus `stoppedProcessId` when a host ended.
- While a stopped host drains, its discovery file is already gone, so `status` and a repeated `stop` report no running host although the process still finishes requests. A `restart` that follows a stop that timed out can therefore start a replacement next to the draining host.
- `AgentLogbook.Client.LocalApiHostControl` holds this logic (`InspectAsync`, `StopAsync`, `RestartAsync`), so the later replacement of a host with another version reuses it.
- A stop request ends the `serve` command like a termination signal: exit code 0.

The override carries no token, so it serves the unauthenticated development and local hosts; an authenticated host needs the login support of the Auth slice. The synchronize conflict kind is not ported, because the synchronize feature is removed.

Typed `HttpStore` methods and the instruction error kinds are added with the slices that port those RPC methods.

## init

`agent-logbook init [--json] [--pretty]` opens the workspace of the current folder on the API host that the routing above selects. It prints what the TypeScript command prints: `Initialized data store at <dbPath>`, or `{"command":"init","dbPath":"<dbPath>","status":"ok"}`. `dbPath` is the API URL, as it is in the TypeScript remote mode. A repeat run prints the same and changes nothing.

The command sends one RPC call, `initializeWorkspace`, with the resolved project identity in `x-agent-logbook-project-identity`. The tenant comes from the login (the Local API host: `local-<OS user name>`), never from the body. `WorkspaceInitializer` (`AgentLogbook.Storage.Postgres/Workspaces`) runs the call in one transaction that is scoped to the tenant for row-level security:

1. It seeds the per-kind counters and the default project and epic. Their IDs derive from the legacy aliases `PROJ0` and `EPIC0` with the retained entity namespace, and they have the titles `Default Project` and `Default Epic`, the literal content hashes of those titles, an empty generated body, and null authors.
2. Without an identity it stops there. The default project is the workspace.
3. With an identity, it takes a transaction-scoped advisory lock for tenant and identity, then picks the project by stable ID or reference, then by normalized title (`PathSegment.Sanitize`). Two matches are an error (`Ambiguous project identity ...`). A stable ID or reference that matches nothing is an error (`Cannot resolve project identity ...`) and rolls the whole call back. Anything else registers a project with that title, a random stable ID, and its own `Default Epic` joined by a `contains` relation.

The result is `InitializedWorkspace`: the tenant, the project and its epic (`id`, `reference`, `shortReference`, `title`), `created`, and the default project and epic. `created` is true when the call adds the project it returns: the registered project when there is an identity, the default project when there is none (so also for the first call on a new tenant).

Differences from the TypeScript implementation, on purpose:

- The TypeScript command makes no RPC call over `HttpStore`; the host opens the workspace lazily on the first project call. The .NET client has no other open step, so `init` calls `initializeWorkspace`. This method is not in the TypeScript RPC inventory.
- There is no `--db` option (no SQLite) and no `--project-identity` option. The project identity comes from the resolver described under `project-identity`.
- An error prints one line (`agent-logbook init: <message>`, or `{"error":"<message>"}` with `--json`) on stderr and exits 1. The TypeScript command prints a stack trace for a human run.
- `/rpc` has no `daemonHealth` method and no build-hash version check (the daemon is removed). A request that the auth provider denies always gets `Invalid or expired bearer token.`; the TypeScript host says `Missing Authorization header.` when the header is absent.
- `/rpc` answers a failure of a database or program with the fixed message `Internal error.`; only the messages of workspace errors reach the caller.

The recorded cases are `cli/init-help`, `cli/init-command-help`, and `cli/init-unknown-option`. The recorder cannot record `init --json` or the human output: it runs the TypeScript CLI without a saved login, and that CLI only opens a store when a login or a daemon exists. The two outputs come from the TypeScript source and are checked by `InitCommandTests` against the real Local API host and PostgreSQL.

## create, show, list

The minimum entity records of the walking skeleton. Five RPC methods and three commands, all through `HttpStore`:

| RPC method | CLI | What it does |
| --- | --- | --- |
| `createEntity` | `create <kind> --title <title> [--parent <id>] [--status <status>] [--category <c>] [--priority <p>] [--type <t>] [--body-file <path\|->]` | Creates an entity under an optional structural parent. Prints `<reference> <kind> <status> <title>`, or `{operation, id, reference, status, revision}` with `--json`. |
| `getEntityDetails` | `show <id>` | Reads an entity by stable ID, reference or short reference, with its incoming and outgoing relations, its derived status, and for an issue its (empty) comment page. |
| `getInitiativeBundle` | `show <initiative>` | An initiative with everything it reaches through relations (PRDs, user stories, ADRs, issues) and the fix, sub-issue, blocker and constrains links. `show` of a plan prints its details with the Plan projection (seven empty groups, empty history). |
| `listEntities` | none | The entities of one kind in the current project, by ID. |
| `queryEntities` | `list <kind> [--status a,b] [--parent <id>] [--limit <n>]` | The same with filters. Prints `{items, total}`; for issues also `openBlockers`. |

`EntityStore` (`AgentLogbook.Storage.Postgres/Entities`) ports the TypeScript `PgEntityStore` with its SQL. Every call is one transaction that is scoped to the tenant for row-level security and acts in the project that `x-agent-logbook-project-identity` names (`TenantWorkspace` resolves it, as `init` does; no identity means the default project).

- **Rules.** `EntityRules` reads the workflow schema (kinds, status flows, allowed parent relations, categories, priorities); entity types are `pioneer-map` and `pioneer-ticket` for issues. The checks and their messages run in the order of the TypeScript `createEntity`: kind, title (trimmed like JavaScript trims it), status, category, priority, type, debt metadata, parent, then the Plan, `pioneer-map` and `pioneer-ticket` parent rules. A parent-less initiative joins the epic of the current project.
- **Stored record.** The entity keeps the literal content hash of title and body, `created_by` and `updated_by` of the user of the login (`StableIdentity.DeriveUser` of the login name), revision 1, and a first row in `revision_entries`: a reverse patch from the entity to itself (empty patch, equal source and target hash) with the canonical state that includes the structural parent. A plan always starts as `draft`.
- **Derived status.** `EntityStatusDerivation` is the port of `deriveEntityStatuses`: an issue with open sub-issues is `blocked`, a user story follows its fixing issues, a PRD its user stories, a draft initiative becomes `active` or `done` with its tracked issues and PRDs, and a superseded ADR, PRD or user story reads as `superseded`. `getEntityDetails`, `listEntities` and `queryEntities` report derived statuses; `createEntity` reports the stored one. The map is built from the whole project (one entity query and one relation query), not from the recursive subset that the TypeScript `queryEntities` uses; the values are the same.
- **Project scope.** With a project identity, `getEntityDetails` only shows entities of that project (`Entity not found: <id>`, or `Entity not found in current project "<title>" (<reference>): <id>` for an issue of another project), and a project identity that is a stable ID or reference keeps the parent of `createEntity` inside that project. Without one, nothing is scoped to a project.

Differences from the TypeScript implementation, on purpose:

- `createEntity` refuses `links` (`Relations cannot be created together with an entity in this release.`) and `create` has no `--link` option. Creating relations belongs to the link feature slice; the approved difference is `create-help-no-link-option` in `contract/intended-differences.json`.
- `getInitiativeBundle` has empty version coverage and `show` of a plan has an empty projection, for the same reason: no ported feature records completions or Plan entries. `queryEntities` takes `limit` as JavaScript `slice(0, limit)` does (a fraction is cut off, a negative limit counts back from the end), and a JSON `null` for `category` or `priority` of `createEntity` is refused as a value.
- `getEntityDetails` returns no plan entries and no version coverage, and an issue has an empty comment page: no ported feature creates them. The slices that port them extend `EntitySession.GetDetailsAsync`.
- A short reference is unique in a tenant (unique index), so `queryEntities` never returns `parentGroups` and a selector never names two entities.
- An error prints one line (`agent-logbook <command>: <message>`, or `{"error":"<message>"}` with `--json`) on stderr and exits 1. The TypeScript command prints a stack trace for a human run. `--title` and `<kind>` are checked when the command runs, with the TypeScript messages, not by the parser.
- A body file is read once, without the retries of the TypeScript command.
- There is no role check on the entity methods (`ApiIdentity` has no roles and the host is local no-auth only). A hosted auth slice must add it before it serves these methods.
- Creates of one tenant take a transaction-scoped advisory lock before they allocate a short reference, so two concurrent creates cannot collide on it (the TypeScript code has that race).
- `queryEntities` has no `retrievalContext` (no workspace observation is ported).

The recorded cases are `rpc/create-entity-fields`, `rpc/create-entity-errors`, `rpc/get-entity-details`, `rpc/get-entity-details-issue`, `rpc/get-initiative-bundle`, `rpc/create-entity-null-fields`, `rpc/list-entities`, `rpc/query-entities`, `rpc/query-entities-limits`, and the `cli/create-*`, `cli/show-*` and `cli/list-*` cases. They pass against the .NET implementation (see tools/README.md). The routes `GET /api/entity-detail` and `GET /api/entity-relations` of the website belong to the Website integration slices, not to the skeleton.

## MCP server

`agent-logbook --mcp [--project-identity <identity>]` runs the MCP server on standard input and output. Hosts start this installed command through plugin configuration or by hand; there is no `dnx` launch path, no `mcp` subcommand and no proxy. `--mcp` is special only as the first argument: the entry point starts the server before the command parser is built, and `agent-logbook schema --mcp` is an unknown option like any other. Another argument after `--mcp` prints `agent-logbook: Usage: --mcp [--project-identity <projectIdentity>]` on stderr and exits 1.

`AgentLogbook.Mcp` uses ModelContextProtocol 2.x over the stdio transport. The server reports `agent-logbook` and the tool version as its server info, and lists the tools that this release implements. A tool that is not ported has no stub, so the tool list is shorter than the TypeScript list.

| Tool | Result |
| --- | --- |
| `project_identity` | `{projectIdentity, workspaceRoot}` of the session |
| `resource_show` | `{entity, reads}` for `request: {resource: "entity", reference}`: the entity metadata without `body` and `bodySource`, and the follow-up reads |

- **Session workspace.** The first `file:` root that the host lists is the workspace. Without the roots capability, a failed roots request or no file root, the folder of the process is the workspace. The project identity is `--project-identity` when given, else the resolved identity of the workspace (`project-identity` above).
- **Store.** `resource_show` opens the store through `WorkspaceStore` (`AgentLogbook.Client`), the same routing, identity and `HttpStore` as the CLI. It reads the entity with `getEntityDetails`.
- **Errors.** A failure that the user can fix (a Local API host that cannot start, an unknown entity, an API error) is a tool result with `isError` and one line of text. A result over 65536 bytes is replaced by the fixed oversize text, as in the TypeScript server. A defect is not hidden.
- **Protocol output.** Standard output holds protocol messages only. The server writes no logs, and no CLI rendering runs. A host that closes the input ends the session with exit code 0.

Differences from the TypeScript server, on purpose:

- `resource_show` accepts the entity resource only. Its schema has one variant and its description is shorter. The `planEntry`, `context`, `contextTerm`, `instructionSource` and `issueBreakdown` resources belong to the slices that port those features. The `reads` of an entity name `resource_body` and `relation_query`, as the TypeScript result does; those tools are not ported yet.
- The `details` read names `agent-logbook show <reference> --json`.
- The tool list has no `execution` field and no `$schema` in the tool schemas (the SDK of the TypeScript server wrote them). The case `mcp/tool-list` omits those two fields on both sides.
- The text of a tool result escapes quotes as `\u0022`. It is the same JSON; `structuredContent` is equal.

The recorded cases are `mcp/server-info`, `mcp/tool-list` (`project_identity`) and `mcp/project-identity`. An MCP case runs the CLI with `--mcp`, sends the steps as JSON-RPC requests, and records the answers, the exit code after the input closes and standard error. The recorder fails when a line of standard output is not a JSON-RPC message. The TypeScript server starts the background daemon for a tool that opens a store, which the recorder does not run, so `resource_show` has no recorded case. The MCP process tests (`tests/AgentLogbook.Cli.Tests/Mcp`) run the real command against the real Local API host and PostgreSQL: they read a real entity, check the error results and check that standard output stays clean. `tests/verify-packed-tool.sh` runs one session of the packed tool.

## Development with Aspire

`AgentLogbook.Hosting` holds the one Aspire composition of Logbook, `AddAgentLogbook()`. `src/AgentLogbook.AppHost` is the standalone AppHost; it only calls the library. A later Helm AppHost calls the same method on its own builder. No AppHost starts another AppHost, and the library does not reference the standalone AppHost.

```sh
dotnet run --project src/AgentLogbook.AppHost   # needs a container engine
```

`AddAgentLogbook()` adds the resources `logbook-postgres` (PostgreSQL `16-alpine`, the major version of `docker/compose.yaml`; the schema signature depends on it), the database `logbook`, and `logbook-api`. `logbook-api` is the **Development API host** (`src/AgentLogbook.DevelopmentApi`). It runs the same `AgentLogbook.Api` code as the Local API host, in no-auth mode on 127.0.0.1, with the Aspire PostgreSQL and a port that Aspire assigns. It differs from the Local API host in three ways:

- It keeps its files in `logbook-net/.agent-shipyard/` (`AGENT_SHIPYARD_HOME`, ignored by Git). It refuses to start when that variable is not set, so it cannot use the user Shipyard data folder.
- It never reads or writes `local-api.discovery.json`.
- A CLI process reaches it only through `AGENT_LOGBOOK_API_URL`. `WithAgentLogbookApi(logbook)` sets that variable on a resource that runs a CLI; it is set in that process only. Saved logins, credentials, and the backend choice do not change.

`AgentLogbookOptions` sets another logbook-net root or Shipyard folder.

`tests/AgentLogbook.Hosting.Tests` checks the resource graph without starting anything, through a consumer that references the library only. `tests/AgentLogbook.AppHost.Tests` starts the real AppHost (PostgreSQL container, API process), resolves a route from `AGENT_LOGBOOK_API_URL` as the CLI does, calls the Development API, and compares the user Shipyard Logbook folder before and after. It skips when no container engine answers, and the application stops its resources at the end.

## Websites in development

`web/` is a pnpm workspace with the copied `site` and `kanban` clients. `AddAgentLogbook()` starts both with
`pnpm` next to PostgreSQL and the Development API host, and gives each one the host URL in `AGENT_LOGBOOK_API_URL` for its Vite proxy.
`web/core` holds only the instruction-store code that the copied site still imports. The generated Website contract, the instruction-editor
changes, and the embedded assets belong to Website integration. The site typecheck waits for that work (it needs the generated types).
