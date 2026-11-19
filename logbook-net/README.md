# logbook-net

.NET 11 / C# 15 implementation of Logbook, packed as `Arcmantle.AgentLogbook` (command `agent-logbook`).

```sh
dotnet build AgentLogbook.slnx
dotnet test --solution AgentLogbook.slnx   # TUnit on Microsoft.Testing.Platform
tests/verify-packed-tool.sh                # required gate: pack, install in an isolated folder, run, uninstall
```

The package is one framework-dependent `any` tool. It has no RID-specific or Native AOT build and only the `agent-logbook` command.

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
