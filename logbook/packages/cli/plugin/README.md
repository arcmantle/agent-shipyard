# Agent Issues Plugin

Agent Issues gives coding agents a durable work model for planning and delivery. It adds workflow skills, an issue-first custom agent, and MCP tools for work that needs clear scope, dependencies, and acceptance criteria.

## Install

Install the two required commands first. The plugin uses `agent-issues-mcp`, which starts `agent-issues --mcp`.

```bash
npm install --global agent-issues agent-issues-mcp
```

Then install the plugin for Copilot CLI or VS Code:

```bash
agent-issues agent init
```

To install for Claude Code, select that host explicitly:

```bash
agent-issues agent init --host claude
```

The command registers this plugin marketplace when necessary, then installs Agent Issues:

```bash
copilot plugin marketplace add arcmantle/agent-issues-plugin
copilot plugin install agent-issues@agent-issues
```

```bash
claude plugin marketplace add arcmantle/agent-issues-plugin
claude plugin install agent-issues@agent-issues --scope user
```

In VS Code, enable `chat.plugins.enabled`. VS Code loads the installed plugin from the shared Copilot plugin directory.

## Included

- An issue-first Agent Issues custom agent for scoped implementation work.
- Skills for planning, issue breakdown, test-driven development, implementation, handoff, and next-work selection.
- MCP tools for initiatives, PRDs, user stories, issues, ADRs, project context, relations, and comments.
- A shared language standard and operating contract for consistent agent behavior.

## Instruction loading

Plugin skill and agent files contain discovery metadata and the reading procedure for `instruction_retrieve`. The tool returns the database Markdown in parts for the running CLI release and current owner. Required fragments are already included.

Each instruction source with local Markdown links has a generated **Referenced Instruction Keys** section. Use its exact keys to retrieve required documents. The build resolves each link from its source file, not from the assembled skill. It rejects missing instruction targets. For example, the context format uses `fragment/domain-modeling/context-format`, not `fragment/context-format`. Reference links do not include document bodies.

Each successful MCP response is at most 64 KiB of serialized UTF-8 JSON. The first text block contains metadata: `version`, `documentHash`, `offset`, and `nextOffset`. The second contains readable Markdown without a duplicate body in structured content. Call again with the same `key` and `documentHash`, with the integer `nextOffset` as `offset`, until `nextOffset` is null. Read all parts in order before using the instructions. All parts must have the same document hash and release version.

The document hash identifies the complete instruction snapshot, including source and fragment revisions. A positive offset requires this hash. Offsets count UTF-16 code units, not bytes; copy the returned value without calculating it. If the document changes, discard all parts and restart with `key` only. Invalid offsets, positions inside a surrogate pair, and wrong document hashes fail without returning partial Markdown. Continuation needs no signed token or server-side state. No local files or shell commands are required. CLI retrieval still returns the complete document in one call.

The CLI supplies immutable release defaults for database import. Personal changes remain in the database. Runtime instructions do not load from plugin files. If the tool is unavailable or retrieval fails, the agent must stop. It must not use cached instructions or another release as a fallback.

## Resource Collections

Use the read-only `resource_list` tool for entity, orphan-entity, Plan-entry, context, comment, instruction-source, and tenant collections. Put resource-specific fields inside `request`. For example:

```json
{ "request": { "resource": "entity", "kind": "issue", "statuses": ["todo"], "limit": 10 } }
```

Use `resource: "orphanEntity"` for orphans, `resource: "planEntry"` with `planId` for Plan entries, or `resource: "context"` with `view: "list"` or `view: "directory"`. Comments require `issueId`. Instruction-source and tenant lists need only their resource kind.

Copy `nextContinuation` into `request.continuation` until null for paged collections. Comments use `nextBefore` and `request.before`; prepend older pages. Keep the same resource, filters, and scope. Pages are live reads, not snapshots. Instruction catalogs retain their existing result contract. The old collection tool registrations and the instruction-inspection `list` action are removed. CLI commands and `instruction_retrieve` remain unchanged.

## Resource Metadata

Use `resource_show` for one entity, current Plan entry, context, context term, instruction source, or issue-breakdown draft. Put the resource kind and its required identifiers inside `request`. Context scope is optional. Draft lookup uses `action: "show"` with `draftId`, or `action: "latest"` with `targetId`.

The tool returns metadata and complete body or detail read references, not authored text or an initiative graph. Follow these references under the same tenant, workspace, and owner selection. Use `relation_query` and `initiative_bundle` explicitly for graph reads. Draft lookup does not change approval state. Instruction source reads do not replace runtime instruction retrieval.

## Resource Text

Use `resource_body` to read entity bodies, Plan-entry bodies, context summaries, term definitions, comment bodies, or unexpanded instruction sources. Follow the shared Resource Body Read recipe and the returned read references. Put resource identifiers, selected revision, offset, and hash inside `request`. Copy each returned `nextOffset` until it is null, then join all Markdown parts without separators.

Each serialized response is at most 65536 UTF-8 JSON bytes. A changed document requires a restart, not partial use. This tool does not assemble instruction fragments. Skill and agent loaders must continue to use `instruction_retrieve`.

## Resource Revisions

Use the read-only `resource_history` tool with a resource-specific `request`. Use `action: "list"` for comments with `commentId`, Plan entries with `entryId`, or instruction sources with `key`. Use `action: "revision"` with a positive `revision` for entities with `entityId`, contexts with optional `scopeRef`, context terms with `term` and optional `scopeRef`, or instruction sources with `key`.

Selected revisions return metadata and body-read references. Follow the returned `resource_body` reference with its selected revision; do not substitute a current body. Comment and Plan-entry lists use ascending revision order and existing bounded pages. Copy `nextContinuation` into `request.continuation` until null with the same resource, action, identifiers, and scope. Instruction histories retain their newest-first result contract. Histories are live reads, not snapshots.

The replaced revision tools and instruction-inspection history actions are removed. Comparison, dependencies, and pending previews remain in `instruction_inspect`. CLI history reads, restore controls, confirmations, and writes remain separate and unchanged.

## Author Instructions

Keep source skills in `packages/cli/skills/<name>/SKILL.md`. The build copies authored Markdown into `instruction-defaults.json`, which ships with the CLI. Discovery files remain small database loaders.

Use an explicit marker where a fragment must appear:

```markdown
<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Agent-Issues Tooling Guide
```

Fragment keys use the path relative to `packages/cli/skills`, without `.md`, in lowercase. For example, `recipes/README.md` has the key `fragment/recipes/readme`.

Ordinary Markdown links remain references. They do not include target content. Retrieval expands explicit markers at their authored positions and uses the current owner-specific fragment content. It rejects missing fragments and cycles without returning partial output.

Changed defaults must ship under a new CLI release version. Do not replace defaults already imported for an existing release.

## Start work

Open a workspace and initialize its local tracker data:

```bash
cd /path/to/workspace
agent-issues init
agent-issues create initiative --title "Platform cleanup"
```

Use the Agent Issues agent when work should follow an existing issue. The agent reads the issue context, keeps changes within its scope, and validates the changed behavior before it finishes.

## Update

Update the command packages and then update the installed plugin:

```bash
npm install --global agent-issues@latest agent-issues-mcp@latest
copilot plugin marketplace update agent-issues
copilot plugin update agent-issues
```

## Help

Run `agent-issues help --json` for the CLI command catalog, or `agent-issues capabilities --json` for the combined command and workflow schema.

For complete documentation, source code, and issue reporting, see the [Agent Issues repository](https://github.com/arcmantle/agent-issues).