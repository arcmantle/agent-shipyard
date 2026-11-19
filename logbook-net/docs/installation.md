# Install and update Agent Logbook

`Arcmantle.AgentLogbook` is one .NET tool package. It gives one command: `agent-logbook`.

## Prerequisite

Install the .NET 11 SDK. The SDK includes the .NET 11 runtime that the tool needs. The tool is framework-dependent, so it does not run without that runtime.

## Install

```sh
dotnet tool install --global Arcmantle.AgentLogbook
```

The package comes from nuget.org. You need no source configuration and no credentials.

## Update

```sh
dotnet tool update --global Arcmantle.AgentLogbook
```

## Check the installation

```sh
agent-logbook --version
```

The command prints the installed tool version.

If your shell prints `command not found`, the global tool folder is not in `PATH`. Add `~/.dotnet/tools` to `PATH`, then open a new shell and run `agent-logbook --version` again.

```sh
export PATH="$PATH:$HOME/.dotnet/tools"
```

Put that line in your shell profile to keep it.

## What the package does not include

- It has one package and one command. There is no `alb` alias.
- There is no local tool manifest. Use `--global`.
- There is no RID-specific package and no Native AOT build.
- There is no npm binary distribution of the .NET tool.
- It does not replace the TypeScript `agent-issues` command.
