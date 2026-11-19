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
