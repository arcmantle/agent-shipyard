# agent-issues

**A project tracker that gives people and AI coding agents the same source of truth.**

`agent-issues` connects requirements, decisions, issues, and project terms in a persistent database. Use the command-line interface (CLI), a browser view, or the Model Context Protocol (MCP) server to work with the same records.

The local workflow uses SQLite and does not need a cloud account. The repository also includes a PostgreSQL API and Microsoft Entra ID authentication for remote use.

[Quick start](#quick-start) · [Demo](#demo) · [Project model](#project-model) · [Engineering decisions](#engineering-decisions) · [Development](#development) · [Documentation](#documentation)

## Why This Exists

A coding session can end before the work does. Requirements, decisions, and project terms must remain available when a person or an agent resumes the task.

`agent-issues` stores that information as linked records, not only as chat history. An issue can refer to the user story it fixes, the decision that constrains it, and the issue that blocks it. A handoff records the context needed to resume work.

The goal is to make the reason for a change available with the task itself.

## What You Can Do

| Capability | Use |
| --- | --- |
| Track linked work | Connect projects, epics, versions, initiatives, requirements, user stories, decisions, and issues. |
| Keep planning state | Record questions, answers, and decisions in Plans for different kinds of work. |
| Track debt | Record accepted costs or risks, their impact, and the work that resolves them. |
| Plan work across sessions | Use Pioneer to map open decisions and resolve linked tickets without loading the whole effort into one session. |
| Share project terms | Store a project glossary and initiative-specific context. Search terms without losing their source scope. |
| Give agents structured access | Use typed MCP tools, JSON output, and command and schema discovery. |
| Inspect work in the browser | Open a live view of the tracker without a separate frontend deployment. |
| Resume a task | Save a handoff linked to its active work. |
| Read earlier revisions | Walk backwards through recorded changes or restore an earlier entity revision without removing its history. |
| Manage agent instructions | Use versioned defaults, personal changes, revision history, and reusable fragments. |
| Select local or remote storage | Use local SQLite or a saved remote login for the PostgreSQL API. |

## Quick Start

Requires **Node.js 24 or newer**. Install the CLI and MCP server:

```bash
npm install --global agent-issues agent-issues-mcp
```

The CLI is also available as `agent-logbook` and `alb`. All three command names
run the same CLI and use the same data.

From your project directory:

```bash
agent-issues init
agent-issues create initiative --title "Improve the release workflow"
agent-issues list initiative
agent-issues site
```

Open the URL printed by `site`. The command starts the local browser server in the background. Stop it with `agent-issues site --stop`.

The default database is `~/.agent-issues/agent-issues.db`. The workspace determines the project scope, including when you run commands from a subdirectory. Use `--db <path>` for a separate database or `--project-identity <id>` to select a project explicitly.

## Demo

This sequence shows how a requirement becomes linked implementation work. Use the IDs returned by each command in place of `<initiative-id>`, `<prd-id>`, `<story-id>`, and `<issue-id>`.

```bash
agent-issues create initiative --title "Reliable releases"
agent-issues create prd --title "Release checks" --parent <initiative-id>
agent-issues create userStory --title "See failed checks before release" --parent <prd-id>
agent-issues create issue --title "Add the release check summary" --parent <initiative-id>
agent-issues link <issue-id> fixes <story-id>
agent-issues show <initiative-id> --json --pretty
agent-issues site
```

The initiative read returns the complete initiative graph. Open the browser view to inspect the same work. Then inspect the agent-facing contract:

```bash
agent-issues capabilities --json
agent-issues context --json
```

`capabilities` returns the command catalog and workflow schema. `context` returns the project context directory. Both give agents a way to discover the project without depending on text from an earlier chat.

## Project Model

| Record | Entity Kind | Purpose |
| --- | --- | --- |
| Project | `project` | Group epics, own versions, and record shared decisions and debt. |
| Epic | `epic` | Group related initiatives within a project. |
| Version | `version` | Identify a release that initiatives and issues can refer to. |
| Initiative | `initiative` | Own a related set of plans, requirements, decisions, debt, and implementation work. |
| Plan | `plan` | Keep planning questions, answers, and decisions in entries for different kinds of work. |
| Product requirements document (PRD) | `prd` | Define requirements within an initiative. |
| User story | `userStory` | Describe a user outcome from a PRD. |
| Architecture decision record (ADR) | `adr` | Record a decision that can constrain implementation. |
| Issue | `issue` | Track implementation work and sub-issues. |
| Debt | `debt` | Record an accepted cost or risk, its impact, evidence, and suggested remediation. |
| Handoff | `handoff` | Record context to resume work on a linked record. |

A Plan is not specific to a PRD. It can support requirements, architecture decisions, implementation approaches, research, or other work that needs a recorded planning process.

Relations give these records meaning beyond a task list:

- Projects contain epics. Epics contain initiatives. Projects own versions; initiatives and issues can be tagged with a version.
- Initiatives own Plans and PRDs and track issues. The `informs` relation can link a Plan to a PRD.
- Projects, epics, and initiatives can record ADRs.
- PRDs create user stories. Issues fix user stories.
- ADRs constrain issues. Issues can block other issues.
- Projects, epics, initiatives, and issues can record debt. Epics, initiatives, and issues can resolve it. Debt can link to related records with `relatesTo`.
- Issues can contain sub-issues. Handoffs link to their active focus with `handsOff`.

Project context holds shared terms. Initiative context holds terms for that initiative. The context directory keeps these scopes distinct.

### Deferred Issues

Use `agent-issues status <issue-id> deferred` for optional work or work that is not actionable yet. Use `agent-issues status <issue-id> todo` to return it to current work. Both changes retain content, ownership, relations, and history.

Deferred issues do not appear in `next-work` or count toward progress totals. A parent can be done when its only unfinished children are deferred. Browser issue lists hide deferred issues by default; use the Deferred or All statuses filter to show them. Deferral does not finish a dependency: an explicit `blocks` relation still applies until its source issue is done. Deferred is an issue-only status, not a replacement for blocked or debt.

## Pioneer

Pioneer is a planning workflow for work that is too large or uncertain for one agent session. It is **not a separate entity kind**. Its map and decision tickets are issues with the types `pioneer-map` and `pioneer-ticket`.

Each effort uses one initiative-owned Plan for detailed planning state. The map records the destination, links to resolved decisions, and questions that are not yet specific enough to become tickets. Child tickets hold specific questions; `blocks` relations identify which decisions must come first.

Tickets can use research, prototypes, live planning conversations, or tasks that supply facts needed for a decision. Resolve available tickets and add new ones as the answers make the next questions clear. The shared map lets later sessions resume without loading every ticket body.

By default, Pioneer produces decisions, not implementation work. The map is complete when no open tickets or unresolved in-scope questions remain. See the [Pioneer workflow](packages/cli/skills/pioneer/SKILL.md) for the full process.

## Engineering Decisions

**Immutable change history, with the latest document stored directly.** The current entity record always holds its latest state. Each recorded change adds an immutable reverse patch to an append-only revision history, rather than storing another complete document snapshot. The patch contains the information needed to recover the preceding state, including changed text and fields.

To read an earlier revision of any entity kind, start with the latest record and apply its patches backwards. Each step checks the source and target state hashes. This reconstructs earlier documents without changing the current record or its history. Entity history includes edits and lifecycle changes such as status, parent, and deletion state. A restore creates a new latest revision; it does not rewrite or remove the changes that came before it.

**One shared domain, several interfaces.** The core package holds the schema, database, and store layers. The CLI, MCP server, and browser app use this shared model. This keeps workflow rules separate from interface code.

**Local use without cloud setup.** SQLite provides the default persistent store. The PostgreSQL API supports the remote path. Local use does not require Entra ID registration or a running PostgreSQL service.

**Explicit contracts for agents.** MCP collection and body reads are bounded to 65536 serialized UTF-8 JSON bytes. Continuation tokens and body hashes support larger reads. JSON output, typed resource requests, and schema discovery reduce dependence on free-form text parsing.

**Guarded changes.** MCP resource edits require an expected revision and content hash. Entity and tenant deletion require an impact inspection and a confirmation token. These checks protect against stale writes and unintended deletion.

**Versioned instructions.** Official instruction defaults are immutable for each release. Personal changes retain revision history. Instruction retrieval validates fragment dependencies and returns an error for missing content or cycles, rather than partial instructions.

## Repository

The project is a **TypeScript ESM pnpm monorepo**.

| Package | Responsibility |
| --- | --- |
| [packages/core](packages/core) | Shared domain, schema, database, and store layers. |
| [packages/cli](packages/cli) | CLI, plugin distribution, and browser server entry point. |
| [packages/mcp-server](packages/mcp-server) | MCP server executable. |
| [packages/api-local](packages/api-local) | Local API implementation. |
| [packages/api-pg](packages/api-pg) | PostgreSQL API and authentication support. |
| [packages/site](packages/site) | Browser app built with Lit and Vite. |
| [packages/kanban](packages/kanban) | Kanban UI package. |
| [packages/vscode-mcp-provider](packages/vscode-mcp-provider) | VS Code MCP provider. |

The browser package also uses Cytoscape for graph views and BlockNote for rich-text editing. Vitest provides the test runner.

## Agent Integration

Install the global packages from [Quick Start](#quick-start), then install the host plugin:

```bash
agent-issues agent init
```

This installs for Copilot CLI and VS Code. In VS Code, enable `chat.plugins.enabled`. For Claude Code:

```bash
agent-issues agent init --host claude
```

The plugin includes agents, workflow skills, and MCP registration. For direct MCP setup, register `agent-issues-mcp` as a stdio command with no arguments. See the [agent integration reference](#agent-integration-installation) for manual installation and updates.

For a multi-root VS Code workspace, set `agentIssues.projectIdentity` in the workspace settings to use one project identity. See the [project identity reference](#mcp-project-identity) for resolution rules and other hosts.

## Development

Requires Node.js 24 or newer and pnpm.

```bash
git clone https://github.com/arcmantle/agent-issues.git
cd agent-issues
pnpm install
pnpm build:dev
```

| Command | Purpose |
| --- | --- |
| `pnpm build:dev` | Build with a content-based development instruction identity. |
| `pnpm build` | Build for a release with immutable instruction defaults. |
| `pnpm site:dev` | Start the Vite development server and local backend. |
| `pnpm typecheck` | Build required packages and run workspace type checks. |
| `pnpm test` | Run workspace tests. |

The site development server uses `http://127.0.0.1:5173`, with the backend on port `4313` by default. Rebuild with `pnpm build:dev` after instruction-source changes. PostgreSQL service tests need the local database setup described below; they are not required for the local SQLite demo.

## Documentation

- [Local API and PostgreSQL development](docs/local-dev-setup.md)
- [Microsoft Entra ID setup](docs/auth-entra-id-setup.md)
- [MCP registry setup](docs/mcp-registry-setup.md)
- [Plugin installation and instruction loading](packages/cli/plugin/README.md)
- [Release notes and contract changes](docs/release-notes.md)
- [Search benchmark](docs/search-benchmark.md)
- [Migration benchmark](docs/migration-benchmark.md)

For command details, use `agent-issues help <command>`. Use `agent-issues schema --json` to inspect supported record kinds, statuses, relations, and parent rules.

## Technical Reference

<details>
<summary>Installation, storage, CLI commands, MCP contracts, and instruction management</summary>

## CLI And MCP Installation

### Requirements

- Node.js 24 or newer

Install both packages globally. `agent-issues` provides the command-line interface. `agent-issues-mcp` provides the MCP server executable. You need both packages for complete CLI and MCP use.

```bash
npm install --global agent-issues agent-issues-mcp
```

Confirm that npm installed both global packages:

```bash
npm list --global --depth=0 agent-issues agent-issues-mcp
```

Initialize the database in a workspace, then use the CLI:

```bash
cd /path/to/workspace
agent-issues init
agent-issues create initiative --title "Platform cleanup"
```

### MCP registration

MCP registration calls `agent-issues-mcp` with no arguments. This executable starts `agent-issues --mcp`. Both commands must be globally installed and available on your `PATH`:

```json
{
	"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
	"mcpServers": {
		"agent-issues": {
			"type": "stdio",
			"command": "agent-issues-mcp",
			"args": []
		}
	}
}
```

Use the host plugin instructions in [Agent integration installation](#agent-integration-installation) to configure Copilot CLI, VS Code, or Claude Code.

## Develop from source

This path is for contributors to this repository. It requires pnpm in addition to Node.js 24 or newer.

The repository is a pnpm monorepo under `packages/`: `@agent-issues/core` holds the shared domain (schema, database, and store layers), `agent-issues` is the CLI, `agent-issues-mcp` is the MCP server executable, `@agent-issues/site` is a Lit app built with Vite and served by the CLI, and `@agent-issues/api-pg` is a deployable cloud API service scaffold.

```bash
git clone https://github.com/arcmantle/agent-issues.git
cd agent-issues
pnpm install
pnpm run build:dev
```

Use `pnpm build:dev` when you change instruction sources. An unchanged development bundle keeps its identity. Changed instruction content produces a new identity such as `0.2.5-dev.<content-hash>`, without a package-version change. CLI, MCP, and site instruction requests use that identity. Existing bundles and personal overrides remain intact.

Use `pnpm build` for a production build. Production instruction defaults use the package version and remain immutable. Changed release defaults require a new package version. An instruction import conflict fails instruction operations without fallback, but does not block ordinary tracker commands.

For frontend development, run `pnpm site:dev` from the repository root or `pnpm --filter @agent-issues/site dev`. The Vite dev server starts the live backend for `site-config.json`, `/api/snapshot`, and `/events`.

### Publish the plugin

The `publish-plugin` workflow job builds `packages/cli/dist/plugin/` and publishes its contents to `arcmantle/agent-issues-plugin` after each successful push to `main`. Set the `AGENT_ISSUES_PLUGIN_REPOSITORY_TOKEN` repository secret to a GitHub App installation token or a fine-grained personal access token with `Contents: Read and write` access to that repository.

## Storage

SQLite is the canonical store.

- Default path: `~/.agent-issues/agent-issues.db`
- Default tenant: derived from the current workspace root, so commands from subdirectories in the same project land on the same tenant inside the shared user-local database
- Override the derived tenant with: `--tenant <name>`
- Override with: `--db /path/to/agent-issues.db`
- Legacy cwd-local `.agent-issues/agent-issues.db` files and previous tenant-local `~/.agent-issues/tenants/<tenant>/agent-issues.db` files are imported into the shared user-local database the first time that tenant is opened without an explicit `--db`

The project glossary lives in this database. It is not a raw `CONTEXT.md` file.

## MCP project identity

The MCP server scopes tracker reads and writes to one project identity. For a VS Code multi-root workspace, set `agentIssues.projectIdentity` in the workspace file:

```json
{
	"folders": [
		{ "path": "api" },
		{ "path": "web" }
	],
	"settings": {
		"agentIssues.projectIdentity": "shared-product"
	}
}
```

The VS Code MCP provider passes this value to the server. An explicit workspace value takes precedence over `.agent-issues.json`, `.agent-issues`, the `.code-workspace` filename, Git remote name, `package.json` name, and folder name.

When the MCP client advertises roots, the server resolves identity from the first `file:` root. That root is the chat folder. If the client does not send roots, the server uses the process working directory.

Outside VS Code, set the same identity in either `.agent-issues.json` or `.agent-issues`:

```json
{ "projectIdentity": "shared-product" }
```

For one command from a different folder, use `--project-identity <id>`. For example, `agent-issues list issue --project-identity shared-product --json` reads the `shared-product` project. A direct MCP server can use the same override: `agent-issues --mcp --project-identity shared-product`.

Use `agent-issues project-identity --json` to inspect the CLI's resolved identity and its source. The MCP server exposes the same resolved value through `project_identity`.

## Resource Collection Reads

Use the read-only MCP tool `resource_list` for collections. Its typed `request.resource` selects `entity` (required `kind`, optional `statuses`, `parentId`, and `limit`), `orphanEntity` (optional `kind`), `planEntry` (required `planId`), `context` (`view: "list"` or `view: "directory"`), `comment` (required `issueId`), `instructionSource`, or `tenant`. For example:

```json
{ "request": { "resource": "entity", "kind": "issue", "limit": 10 } }
```

Paged collections return `nextContinuation`; copy it into `request.continuation` with the same request until null. Comments return `nextBefore`; copy it into `request.before` and prepend older pages to keep chronological order. The optional comment `all` flag cannot disable paging. Instruction catalogs retain their existing result contract.

Existing bounded summary pages remain within 65536 serialized UTF-8 JSON bytes. Follow returned read references for complete bodies and metadata. Continuation is bound to the resource, selected operation, tenant, workspace/project, filters, limits, order, and server process. Invalid or cross-resource tokens return errors without a page. Pages are live reads, not snapshots. Complete CLI collection commands are unchanged. The replaced collection tools have no public aliases.

## Resource Text Reads

Use the read-only MCP tool `resource_body` for complete current or historical text. Its typed `request.resource` selects `entity` (`entityId`), `planEntry` (`entryId`), `context` (optional `scopeRef`), `contextTerm` (`term` and optional `scopeRef`), `comment` (`commentId`), or `instructionSource` (`key`). For example:

```json
{ "request": { "resource": "entity", "entityId": "<entity-reference>", "revision": 1 } }
```

Omit `revision` for current text. The first text block contains resource identity, revision, scope, `documentHash`, `offset`, and `nextOffset`. The second contains Markdown. Copy `nextOffset` into `request.offset` with the same request and returned hash until it is null. Join all Markdown parts without separators. Each serialized response is at most 65536 UTF-8 JSON bytes and does not duplicate text in structured content.

Invalid requests, unavailable revisions, and mismatched hashes return errors without partial text. A changed current body requires a restart without offset and hash. A selected historical revision stays fixed. Hashes are bound to resource kind, revision, tenant, workspace, and applicable instruction owner.

Returned body-read references use `resource_body`. The separate entity, comment, and Plan-entry body tools are removed. Complete CLI reads are unchanged. Instruction-source reads do not expand fragments; runtime skill and agent loaders continue to use `instruction_retrieve`.

## Resource Revision Reads

Use the read-only MCP tool `resource_history` with a typed `request` object. Use `action: "list"` for `comment` (`commentId`), `planEntry` (`entryId`), or `instructionSource` (`key`). Use `action: "revision"` with a positive `revision` for `entity` (`entityId`), `context` (optional `scopeRef`), `contextTerm` (`term` and optional `scopeRef`), or `instructionSource` (`key`). Other resource/action combinations are not supported.

```json
{ "request": { "resource": "entity", "action": "revision", "entityId": "<entity-reference>", "revision": 1 } }
```

Selected revisions return historical metadata and revision-pinned `resource_body` references, not historical text. Keep target and head revision meanings distinct. Comment and Plan-entry histories retain ascending revision order, 65536-byte summary pages, and `nextContinuation`; copy it into `request.continuation` with the same request until null. Instruction histories retain their existing newest-first collection contract.

Continuation is bound to resource kind, action, identity, scope, order, and server process. Invalid or cross-resource reuse returns an error without a page. Histories are live reads, not snapshots. The separate revision tools and the instruction-inspection `history` and `revision` actions are removed without aliases. CLI history commands, restores, confirmations, and writes remain unchanged.

## Resource Creation

Use the MCP tool `resource_create` with one typed `request` variant to create an entity, comment, or Plan entry, or to create or update context text. For example:

```json
{ "request": { "resource": "entity", "kind": "issue", "title": "Track the change" } }
```

Set `request.resource` to `entity`, `comment`, `planEntry`, or `context`, then provide the fields for that resource. The `context` variant preserves `context_set` upsert behavior and accepts optional revision and content-hash checks. The dedicated `entity_create`, `comment_create`, `plan_entry_create`, and `context_set` tools are removed without aliases. CLI commands are unchanged.

## Resource Editing

Use the MCP tool `resource_edit` with one typed `request` variant to edit an entity, comment, or Plan entry. All variants require `expectedRevision` and `expectedContentHash`. For example:

```json
{ "request": { "resource": "entity", "entityId": "<entity-reference>", "title": "Updated title", "expectedRevision": 1, "expectedContentHash": "<content-hash>" } }
```

Set `request.resource` to `entity`, `comment`, or `planEntry`, then provide that resource's fields. The dedicated `entity_edit`, `comment_edit`, and `plan_entry_edit` tools are removed without aliases. CLI edit commands are unchanged.

## Resource Deletion

Use the MCP tool `resource_delete` with a typed `request` to delete an entity, tenant, comment, Plan entry, or context term. Entity and tenant requests support `action: "inspect"` to return the deletion impact and a one-use confirmation token, then `action: "delete"` with that token. Request an inspection first:

```json
{ "request": { "resource": "entity", "action": "inspect", "entityId": "<entity-reference>" } }
```

Then submit the deletion request with the returned token:

```json
{ "request": { "resource": "entity", "action": "delete", "entityId": "<entity-reference>", "confirmationToken": "<token>" } }
```

Comment and Plan-entry deletes require `expectedRevision` and `expectedContentHash`. Context-term deletes accept those fields when available and retain the existing store checks. The dedicated entity, tenant, comment, Plan-entry, and context-term delete tools are removed without aliases. CLI delete commands are unchanged.

## Instruction Retrieval

Use `agent-issues instruction retrieve skill/prepare --json` or the MCP `instruction_retrieve` tool to retrieve instructions for the running CLI release. Both use the database source and return complete assembled Markdown.

To include a fragment, insert `<!-- include:fragment/rules -->` in the source Markdown. The marker is reserved instruction syntax wherever it occurs in the source. Include targets must be fragment keys, not skill or agent keys. Nested and repeated includes expand at the marker position in text order. No extra whitespace or newline is inserted around fragment content.

The response contains the requesting release in `version`, the source revision and source-content hash in `source`, and each included fragment's key and source metadata in `fragments`. The fragment list contains each key once, in first-use order. Hashes describe stored source Markdown, not the assembled body.

SQLite reads the release content in one transaction. PostgreSQL reads defaults, authenticated owner overrides, and personal fragments in one SQL statement. Both validate the complete dependency graph before returning a document. Missing defaults, unavailable storage, missing fragments, forbidden targets, and cycles return errors without partial instructions or fallback content. A returned document does not refresh after a later database change; retrieve it again to get the current content.

### Manage Instruction Source

The MCP server exposes instruction tools and shared resource readers. Each management tool takes a typed `request` object. The required fields depend on the selected resource, action, or reset scope and phase.

| Tool | Request Selection |
| --- | --- |
| `instruction_retrieve` | Keep the existing `key`, `offset`, and `documentHash` inputs for complete skill and agent instructions. |
| `resource_list` | Set `request.resource` to `instructionSource` for the owner's catalog, or select another supported collection. |
| `resource_show` | Read entity, Plan-entry, context, context-term, instruction-source, or issue-breakdown metadata. Follow returned body or complete detail references. |
| `resource_history` | List supported resource revisions or read selected entity, context, context-term, or instruction-source revision metadata. |
| `instruction_inspect` | Set `request.action` to `compare`, `dependencies`, or `preview`. No changes are saved. |
| `instruction_update` | Set `request.action` to `save`, `commit`, `restore`, `create_fragment`, or `remove_fragment`. |
| `instruction_reset` | Set `request.scope` to `one` or `all`, and `request.phase` to `inspect` or `apply`. Apply requires confirmation. |

These tools replace the separate instruction management tools. CLI commands remain unchanged. Restart the MCP server and refresh its tool catalog after an update.

Use `agent-issues instruction list --json` to list the current owner's agent, skill, and fragment sources. Use `agent-issues instruction read <key> --json` to read source Markdown without expanding includes. Use MCP `resource_list({ request: { resource: "instructionSource" } })` for the catalog. Use `resource_show({ request: { resource: "instructionSource", key: "skill/prepare" } })` for source metadata, then follow its `reads.body` reference to `resource_body` for complete unexpanded Markdown.

Use `resource_show({ request: { resource: "entity", reference: "<reference>" } })` for entity metadata, `resource: "planEntry"` with `entryId` for current Plan-entry metadata, or `resource: "context"` with optional `scopeRef` for context metadata and term summaries. Select one term with `resource: "contextTerm"`, `term`, and optional `scopeRef`. Read bodies separately through the returned references. For draft lookup, use `resource: "issueBreakdown"` with `action: "show"` and `draftId`, or `action: "latest"` and `targetId`. Draft issue specifications remain available through the returned complete CLI detail reference. These reads do not load initiative graphs or change approval state.

```json
{ "request": { "resource": "instructionSource", "key": "skill/prepare" } }
```

CLI updates keep personal overrides by stable item key and retain their original `source.defaultVersion`. Unchanged items use the requesting release's defaults. Reads and catalog items include `releaseChanges` when an override's original release differs from the requesting release. This metadata identifies the applicable `defaultVersion`, whether its default body changed, and added, removed, or changed fragment dependencies. Dependency inspection includes nested references from official defaults and personal source. It does not merge or rewrite edits.

`releaseChanges.newerDefaultAvailable` compares semantic release versions. It is `false` for an older requested release and `null` for bundle keys with no semantic version order. Missing or invalid dependencies still prevent runtime retrieval without fallback. Source reads remain available for repair.

Save an existing source with `agent-issues instruction save <key> --body-file <path|-> --expected-revision <revision> --json`. Use the revision from the source read. Use MCP `instruction_update` with `request.action` set to `save`, plus `key`, `body`, and `expectedRevision` inside `request`. Both select defaults for the running CLI release and return the same saved source metadata.

A save creates or updates a personal override, or updates an existing personal fragment. It cannot change immutable defaults, discovery metadata, or another cloud owner's content. Local mode uses one local profile. Cloud mode uses the authenticated tenant and user across projects. Validated changes apply to the next retrieval, not to documents already loaded.

Stale revisions and invalid dependencies leave saved content unchanged. CLI JSON failures return exit code 1. MCP failures set `isError`. Both return `reason` and `currentSource` with current Markdown, revision, and content hash for comparison and retry. Cloud saves serialize changes within one owner's set before revision checks and final-graph validation.

### Compare Instruction Defaults

Use `agent-issues instruction compare <key> --json` or MCP `instruction_inspect` with `request.action` set to `compare` and `request.key`. Both compare the owner's source with the running CLI release's default, not the service release. The result includes both unassembled Markdown bodies as `currentSource` and `defaultSource`, their revision metadata, and `different`. An override retains its original `currentSource.source.defaultVersion` and applicable `releaseChanges` metadata.

`newerDefaultVersions` lists installed defaults for that item with semantic versions later than the requesting release, in ascending order. A personal fragment has no official default: `defaultSource` and `different` are `null`. Comparison does not save content, change revisions or history, or merge personal edits. Missing items, missing release bundles, and unavailable storage return errors without partial output or fallback.

### Instruction Revision History

Use `agent-issues instruction history <key> --json` to list saved source revisions, newest first. Use `agent-issues instruction revision <key> --revision <revision> --json` to read saved Markdown and its source metadata without expanding fragments. Use MCP `resource_history` with `request.resource` set to `instructionSource`, `request.action` set to `list` or `revision`, and `request.key`. The `revision` action also requires `request.revision` and returns metadata with a selected-revision body reference. Follow that reference for complete unexpanded Markdown.

Restore with `agent-issues instruction restore <key> --revision <revision> --expected-revision <current-revision> --json`. Use MCP `instruction_update` with `request.action` set to `restore`, plus `key`, `revision`, and `expectedRevision` inside `request`. Restore creates a new saved revision and validates its dependencies against the requesting CLI release. It does not replace official defaults or change instructions already loaded into a task. Stale revisions and invalid dependencies leave saved source and history unchanged.

History belongs to the instruction owner, not the selected project. The migration retains each existing override as a history entry. It cannot recover revisions that storage discarded before this feature was installed. Official defaults remain separate from saved personal history.

### Reset One Instruction

Use `agent-issues instruction reset-inspect <key> --json` before confirmation. The result shows `currentSource`, `proposedSource`, `affectedInstructions`, and `modifiedFragments`. Modified fragments remain active after the selected source returns to its default. Inspection does not save changes.

Confirm with `agent-issues instruction reset <key> --expected-revision <current-revision> --yes --json`. Use MCP `instruction_reset` with `request.scope` set to `one`, `request.phase` set to `inspect`, and `request.key`. Inspection returns a single-use confirmation token that expires after five minutes. After review, set `request.phase` to `apply` and supply its `confirmationToken`, the item `key`, and `expectedRevision` inside `request`. A changed inspection requires a new token.

Reset removes only the selected override. The source uses the requesting CLI release's default and follows later release defaults. Its history records the reset as a new revision. Fragment overrides, unrelated items, other owners, and official bundles remain unchanged. Stale revisions and invalid dependency graphs leave source and history unchanged. Personal fragments have no official default and cannot be reset. Site reset controls are separate work.

### Reset All Instructions

Use `agent-issues instruction reset-all-inspect --json` before confirmation. The result identifies the owner and requesting release. It lists every `override`, including items absent from that release, every `personalFragment`, proposed defaults, affected instructions, and `expectedRevisions`. The response fields for the item lists are `overrides` and `personalFragments`. A removed release item has a `null` proposed source. Inspection does not save changes.

Confirm with `agent-issues instruction reset-all --input-file <path|-> --yes --json`. The JSON input contains the inspected `expectedRevisions` array. Each entry has an item `key`, `sourceType` (`override` or `personal`), and its `expectedRevision`. The source type distinguishes a hidden override from a personal fragment with the same key. The complete inspection response can also be used as input.

Use MCP `instruction_reset` with `request.scope` set to `all` and `request.phase` set to `inspect`. Inspection returns a single-use `confirmationToken` that expires after five minutes. After review, set `request.phase` to `apply` and supply that token and the inspected `expectedRevisions` inside `request`. A changed owner or proposal requires a new token. A token cannot authorize a different reset scope. The CLI-served site exposes `GET /api/instructions/reset-all/inspect` and `POST /api/instructions/reset-all` with the same confirmation fields.

Reset All clears owner overrides and removes personal fragments in one transaction. It validates the final official-default graph rather than intermediate states. The active set returns to the running CLI release's defaults. Official bundles and other owners remain unchanged. History retains reset revisions and fragment removal records. Stale revisions, a changed affected-item set, missing bundles, and invalid final dependencies leave saved content unchanged. Revision failures include `reason` and `currentInspection` for comparison and retry.

### Preview Pending Instructions

Use `agent-issues instruction preview <key> --input-file <path|-> --json` to assemble unsaved source. The input contains a non-empty `changes` array of unique existing item keys and pending Markdown bodies. Use MCP `instruction_inspect` with `request.action` set to `preview`, plus `key` and the same array inside `request`. The CLI-served site provides `POST /api/instructions/preview` with `key` and `changes` at the top level.

```json
{
	"changes": [
		{ "key": "skill/prepare", "body": "Prepare with <!-- include:fragment/rules -->" },
		{ "key": "fragment/rules", "body": "Pending rules." }
	]
}
```

All interfaces select the running CLI release and the current owner. Pending bodies replace saved bodies only for this assembly. Unchanged items come from one consistent snapshot. Nested and repeated includes use the retrieval rules.

Responses contain `pending: true`, sorted `pendingKeys`, assembled `body`, and release and source metadata. Source revisions and hashes identify the saved base content, not an invented pending revision. Human CLI output starts with `Pending`.

Preview does not save content, change revisions or history, create drafts, or activate instructions. Missing content, invalid targets, cycles, duplicate changes, and unavailable storage return errors without partial output. The site preview view is separate work.

### Atomic Instruction Changes

Use `agent-issues instruction commit --input-file <path|-> --json` to save related sources and remove personal fragments in one transaction. The input is a JSON object with a `changes` array. Use MCP `instruction_update` with `request.action` set to `commit` and the same array in `request.changes`. Each item requires a unique `key`, an `operation` (`save` or `remove`), and `expectedRevision`. A save also requires a Markdown `body`.

```json
{
	"changes": [
		{ "operation": "remove", "key": "fragment/personal", "expectedRevision": 1 },
		{ "operation": "save", "key": "skill/prepare", "body": "Prepare without the personal fragment.", "expectedRevision": 2 }
	]
}
```

Every revision is checked against the saved set. Validation uses the complete final dependency graph, not intermediate changes. Reference changes and fragment removal can therefore commit together, regardless of input order. Saved overrides outside the requested release also protect their fragment references. Only personal fragments can be removed.

A stale revision or invalid final graph leaves every source and its history unchanged. Successful responses identify the requesting CLI release and each changed source revision. Concurrent retrieval returns the complete old or new set, not an intermediate set. The operation does not create drafts or change instructions already loaded into a task.

### Personal Fragments

Create a fragment with `agent-issues instruction fragment create fragment/my-rules --body-file <path|-> --json`. Use MCP `instruction_update` with `request.action` set to `create_fragment`, plus `key` and `body` inside `request`. Keys must use the `fragment/` prefix and the same lowercase key format as official items. Creation rejects duplicate keys, missing include targets, and cycles. It does not add a discoverable skill.

Read and edit the fragment with `instruction read` and `instruction save`, or their matching MCP tools. Its source type is `personal`. The catalog and later retrievals include the saved fragment within the same owner scope across projects and releases.

Remove it with `agent-issues instruction fragment remove fragment/my-rules --expected-revision <revision> --json`, or MCP `instruction_update` with `request.action` set to `remove_fragment`, plus `key` and `expectedRevision` inside `request`. Only personal fragments can be removed. Saved references block removal; errors include `affectedReferences` with the referring item keys. Stale revisions leave the fragment unchanged. Creation, edits, and removal retain revision records. Recreating a removed key continues its revision sequence, so an earlier revision cannot remove the new fragment.

## Context

Context is a first-class database-backed concept.

- Read the project-wide context directory with `agent-issues context --json`.
- Search project-wide context discovery with `agent-issues context search <query> [--view <all|global|initiatives>] --json`.
- Return only matching terms for agent-oriented search with `agent-issues context search <query> [--view <all|global|initiatives>] --terms-only --json`.
- List duplicate labels across scopes with `agent-issues context conflicts [<query>] --json`.
- Read only the shared project glossary with `agent-issues context show default --json`.
- List available contexts with `agent-issues context list --json`.
- Read project or initiative context with `agent-issues context show <entityOrProjectOrInitiativeId> --json`.
- Initialize or update context metadata with `agent-issues context set --scope <entityOrProjectOrInitiativeId|default> --title ... --body-file <path|-> --json`.
- Add or update a canonical term with `agent-issues context define <term> --scope <entityOrProjectOrInitiativeId|default> --body-file <path|-> [--avoid ...] --json`.
- Remove a stale term with `agent-issues context forget <term> --scope <entityOrProjectOrInitiativeId|default> --json`.

The project context holds project-wide terms. Initiative context holds workstream-specific terms. The project-wide context directory preserves source scope so initiative-local terms do not silently become project-canonical. Agents should read the context for the active project or initiative before they use project-specific terms and should update it immediately when a term is resolved.

## Commands

```bash
agent-issues init
agent-issues context --json
agent-issues context search review --view initiatives --json
agent-issues context search review --view initiatives --terms-only --json
agent-issues context conflicts --json
agent-issues context list --json
agent-issues context show default --json
agent-issues context show --view global --query Administration --json
agent-issues context show INIT1 --json
agent-issues context set --scope INIT1 --title "Payments Context" --body-file /tmp/payments-summary.md
agent-issues context define "Order" --scope INIT1 --body-file /tmp/order-definition.md --avoid "purchase, transaction"
agent-issues help create --json
agent-issues schema --json
agent-issues capabilities --json
agent-issues current-tenant
agent-issues list-tenants --json
agent-issues init --tenant payments
agent-issues site --port 4300
agent-issues site --tenant payments
agent-issues site --stop
agent-issues archive ISS1
agent-issues create initiative --title "Platform cleanup"
agent-issues delete ISS2
agent-issues create prd --title "Workflow PRD" --parent INIT1
agent-issues create userStory --title "Story one" --parent PRD1
agent-issues create issue --title "Implement CLI" --parent INIT1
agent-issues create issue --title "Handle parser edge cases" --parent ISS1
agent-issues show INIT1 --json
agent-issues create handoff --title "Resume parser work" --body-file - --link handsOff ISS1
agent-issues edit HO1 --title "Resume parser work" --body-file -
agent-issues move US1 PRD2
agent-issues move ISS7 ISS1
agent-issues relations ISS1
agent-issues orphans
agent-issues link ISS1 fixes US1
agent-issues unlink ISS1 fixes US1
agent-issues show ISS1 --json
agent-issues list issue
agent-issues auth login
agent-issues auth list
agent-issues auth status
agent-issues auth switch work
agent-issues auth switch
agent-issues auth logout work
```

## Current relation model

- Projects contain epics; epics contain initiatives.
- Projects own versions; initiatives and issues can be tagged with versions.
- Initiatives own Plans and PRDs. Plans can inform PRDs.
- PRDs create user stories.
- Projects, epics, and initiatives record ADRs.
- Projects, epics, initiatives, and issues record debt.
- Epics, initiatives, and issues can resolve debt; debt can link to related records.
- Initiatives track issues.
- Issues can decompose into sub-issues.
- Issues fix user stories.
- ADRs constrain issues.
- Issues block other issues.
- Handoffs are entities linked to their active focus with `handsOff`.

## Output

- Default output is human-readable text.
- Use `--json` for machine-readable output. Entity lists return `{ items, total }`, relations return summaries, and mutations return compact acknowledgements.
- Use `show <id> --json` for a complete entity read, including authored body content. `show <initiativeId> --json` returns the complete initiative graph.
- Add `--pretty` with `--json` when you want indented JSON.
- Human-readable output is unchanged by the JSON response-shape change. See [release notes](docs/release-notes.md) for migration details.

## Tenant management

- `current-tenant` shows the tenant the CLI will use from the current workspace root.
- `list-tenants` shows all tenant namespaces currently present in the selected database.
- `delete-tenant <tenantId> --force` removes one tenant and all of its rows.
- `rename-tenant <tenantId> <newTenantId> --force` renames one tenant namespace across all stored rows.

## Auth (Entra ID)

The cloud API (`@agent-issues/api-pg`) validates requests through a swappable `AuthProvider` seam, with Entra ID (Azure AD) as the first concrete provider. The CLI stores named remote logins and includes a permanent built-in local login:

```bash
agent-issues auth login
agent-issues auth login --name work --url https://agent-issues.example.com # one-shot
agent-issues auth list
agent-issues auth status
agent-issues auth switch work
agent-issues auth switch
agent-issues auth logout work
```

- `auth login` prompts for a name and service URL, discovers the service's Entra configuration, runs the interactive device-code flow, and saves the resulting remote login.
- `auth login --name <name> --url <url>` supplies both values for one-shot or automated use.
- `auth list` shows the permanent local login first, then remote saved logins in creation order, and marks the active login.
- `auth switch <name>` activates local or a named remote login directly. Bare `auth switch` advances through local, each remote in creation order, and wraps to local.
- The active saved login controls routing globally for subsequent CLI requests.
- `auth logout [name]` removes a remote saved login; removing the active remote atomically falls back to local.
- Remote credentials are stored in the OS credential store, not plaintext files.
- `auth status` never prints the raw access token.
- You need a real Entra ID app registration before `auth login` will work. See [`docs/auth-entra-id-setup.md`](docs/auth-entra-id-setup.md) for a step-by-step guide to creating one.

### Local dev auth (no Azure required)

`LocalAuthProvider` remains available inside `@agent-issues/api-pg` for API service tests and local service development only. It is not exposed through `agent-issues auth login`; local CLI storage uses the permanent built-in `local` saved login. See [`docs/local-dev-setup.md`](docs/local-dev-setup.md).

## Discovery

- `context` exposes database-backed glossary records, primarily scoped per initiative.
- `help` shows the command catalog or command-specific help.
- `schema` exposes entity kinds, statuses, archive mappings, allowed relations, and structural parent rules.
- `capabilities` returns both the help catalog and the workflow schema in one call.
- `site` starts a local HTTP view in the background and prints its URL.
- `site --stop` asks the local live server on the selected port to stop.
- `agent-issues help <command> --json` is the main LLM-facing command discovery surface.
- `agent-issues schema --json` is the main LLM-facing workflow schema surface.
- `agent-issues capabilities --json` is the fastest single-shot discovery call for an LLM.
- `agent-issues site` is the quickest way to inspect the full graph with live refresh.

## Agent integration installation

Install both global packages before you install a host plugin. The plugin registers the `agent-issues-mcp` command described in [MCP registration](#mcp-registration).

Use one command to install the plugin for Copilot CLI or VS Code:

```bash
agent-issues agent init
```

To install for Claude Code, select that host explicitly:

```bash
agent-issues agent init --host claude
```

### Copilot CLI and VS Code

```bash
copilot plugin marketplace add arcmantle/agent-issues-plugin
copilot plugin install agent-issues@agent-issues
```

VS Code discovers this shared plugin from `~/.copilot/installed-plugins/` and loads its agents, skills, and MCP server. Set `chat.plugins.enabled` to `true` in VS Code.

Update the marketplace, then update the installed plugin:

```bash
copilot plugin marketplace update agent-issues
copilot plugin update agent-issues
```

Remove the shared plugin with `copilot plugin uninstall agent-issues`. In VS Code, use the Agent Plugins - Installed view to inspect, enable, disable, or uninstall plugins.

### Claude Code

```bash
claude plugin marketplace add arcmantle/agent-issues-plugin
claude plugin install agent-issues@agent-issues --scope user
```

Update the marketplace, then update the installed plugin:

```bash
claude plugin marketplace update agent-issues
claude plugin update agent-issues@agent-issues
```

Remove the plugin with `claude plugin uninstall agent-issues@agent-issues`.

## Browser viewer

The browser viewer is built from the separate Lit project in `packages/site/`. Root `pnpm run build` builds both the CLI and the viewer.

For local UI work, `pnpm site:dev` starts Vite on `127.0.0.1:5173` and automatically spins up the live backend on `127.0.0.1:4313` unless something is already listening there.
Set `AGENT_ISSUES_DB` if you want the dev server to target a specific database path, or use a named tenant via the regular CLI commands when you are not overriding the DB path directly.

### Live view

Use `agent-issues site` to start a detached local HTTP server that serves the built viewer and refreshes when the database changes.

- Default live server: `agent-issues site`
- Choose a port: `agent-issues site --port 4300`
- Stop the server: `agent-issues site --stop`

The live server exposes the viewer assets together with `site-config.json`, `/api/snapshot`, and `/events`.

## Query-focused commands

- `show <initiativeId>` returns one complete initiative graph directly.
- Initiative bundles include structural sub-issue links so issue trees can be reconstructed in the CLI and UI.
- `create handoff --title ... --body-file - --link handsOff <focusId>` records a handoff as a graph entity.
- `list handoff`, `show HOx`, `relations HOx`, and `edit HOx --title ... --body-file -` read and update handoffs through the generic entity commands.
- `relations <entityId>` returns incoming and outgoing relations for one entity.
- `orphans [kind]` returns entities not reachable from any initiative.

## Destructive commands

- `archive <id>` moves an entity to its terminal archive status.
- `unlink <from> <type> <to>` removes a relation unless that would orphan a subtree.
- `delete <id>` deletes a leaf entity after its outgoing relations are gone.

## Move command

- `move <id> <newParentId>` reparents an entity by replacing its structural parent relation in one guarded operation.
- For issues, `move` can also reparent a sub-issue under a different parent issue.

</details>