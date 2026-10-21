# Agent Issues MCP Registry Setup

## Registry entry

Add this object to the `servers` array in the company MCP registry:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "no.eye-share/agent-issues",
  "title": "Agent Issues",
  "description": "Manage project context, initiatives, decisions, stories, and issues",
  "version": "0.2.5",
  "repository": {
    "url": "https://github.com/arcmantle/agent-issues",
    "source": "github"
  },
  "packages": [
    {
      "registryType": "npm",
      "identifier": "agent-issues-mcp",
      "version": "0.2.5",
      "transport": {
        "type": "stdio"
      }
    }
  ]
}
```

The npm package `agent-issues-mcp@0.2.5` must be published before a client can install this registry entry. Keep this registry version fixed unless the proxy contract itself must change.

## How it works

The registry package is a small, stable proxy:

```text
MCP client
  -> globally installed agent-issues-mcp@0.2.5
  -> agent-issues --mcp
  -> current MCP tools, local daemon, and storage
```

The proxy forwards MCP messages over standard input and output. It does not contain MCP tools, database code, or business rules. The installed `agent-issues` CLI supplies all changing behavior.

This split has two update paths:

- Install and approve `agent-issues-mcp@0.2.5` once.
- Update `agent-issues` when new commands, tools, or fixes are released.

The proxy requires the `agent-issues` command to be on `PATH`. Both packages require Node.js 24 or newer.

## Install the CLI

Install the current Agent Issues CLI and the approved MCP proxy before starting the MCP server:

```bash
npm install --global agent-issues agent-issues-mcp@0.2.5
```

Confirm that both commands are available after the MCP package is installed:

```bash
command -v agent-issues
command -v agent-issues-mcp
```

## GitHub Copilot CLI

### Install from the company registry

Start Copilot CLI with experimental registry search enabled:

```bash
copilot --experimental
```

Then search the configured company registry:

```text
/mcp search agent-issues
```

Select **Agent Issues** and save the configuration. Copilot CLI uses the company registry configured by the organization instead of the public registry.

Check the installed server:

```bash
copilot mcp list
copilot mcp get agent-issues
```

### Manual fallback

If registry search is unavailable, install and configure the approved proxy directly:

```bash
npm install --global agent-issues-mcp@0.2.5
copilot mcp add agent-issues -- agent-issues-mcp
```

From the shell, use `copilot mcp get agent-issues`. Inside an interactive Copilot CLI session, use `/mcp list` or `/mcp show agent-issues` to check the connection and available tools.

## Claude Code

Claude Code does not install from the Copilot custom registry. Install the approved npm proxy, then add its command as a local stdio server:

```bash
npm install --global agent-issues-mcp@0.2.5
claude mcp add --transport stdio --scope user agent-issues -- agent-issues-mcp
```

The `user` scope makes the server available in all local projects. Use `--scope local` for only the current project, or `--scope project` to write a shared `.mcp.json` entry.

Check the connection:

```bash
claude mcp list
claude mcp get agent-issues
```

You can also open Claude Code and use:

```text
/mcp
```

## Project identity

By default, Agent Issues derives the project identity from the chat folder. The MCP server asks the client for roots and uses the first `file:` root. If the client does not send roots, the server uses the process working directory. To use an explicit shared identity, add one of these files to the project root:

```json
{
  "projectIdentity": "shared-product"
}
```

Use `.agent-issues.json` or `.agent-issues` as the filename. You can also set `AGENT_ISSUES_PROJECT_IDENTITY` in the MCP server environment.

## Updating

Update only the CLI for normal Agent Issues releases:

```bash
npm install --global agent-issues@latest
```

Do not update the fixed proxy for new Agent Issues commands or MCP tools. A new proxy release and a new registry review are necessary only if the permanent proxy contract changes, such as the `agent-issues` executable name or its `--mcp` mode.

## Troubleshooting

If the MCP client reports that it cannot start Agent Issues, check:

```bash
node --version
command -v agent-issues
command -v agent-issues-mcp
npm list --global agent-issues agent-issues-mcp --depth=0
```

Node.js must be version 24 or newer, and both commands must be visible in the environment used by the MCP client. GUI applications can have a different `PATH` from an interactive terminal.
