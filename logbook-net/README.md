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
