# Agent Wayfinder Command Reference

Load this reference when you need exact CLI syntax or flags.

## Install And Launch

Install the released CLI with Node.js 18 or later:

```bash
npm install --global agent-wayfinder
agent-wayfinder install
agent-wayfinder --help
a-wayfinder --help
```

The canonical scoped npm package is `@arcmantle/agent-wayfinder`.

`agent-wayfinder install` writes the skill to
`~/.agents/skills/agent-wayfinder`. Use `agent-wayfinder install --project` to
write it to `./.agents/skills/agent-wayfinder` in the current project. Running
the command again updates the installed skill.

In the Agent Wayfinder source repository, this command runs the current source:

```bash
go run ./cmd/agent-wayfinder --help
```

Use one launcher consistently in a command sequence.

## MCP

When an Agent Wayfinder MCP server is available, use its `ask`, `query`, `path`,
`inspect`, and `export` tools instead of the matching CLI commands. Tool input
uses the same workspace, database, traversal limit, project, and relation
values described below. Tool results use the same JSON result envelope.

The MCP server is read-only. Use the CLI for `install`, `index`, and `indexer`.
To start the stdio server directly, run:

```bash
agent-wayfinder mcp
```

## Database

The default database is:

```text
<WORKSPACE>/.agent-wayfinder/graph.db
```

Commands resolve `WORKSPACE` and `--database` to absolute paths. Use the same workspace and database path for indexing and queries.

## Index

Build or refresh the published graph:

```bash
agent-wayfinder index WORKSPACE [--database PATH] [--format text|json]
```

`index` creates the default database directory when needed. JSON output includes the graph version, publication time, workspace, and extraction diagnostics.

## Ask

Ask one natural-language question with the selected AI provider:

```bash
agent-wayfinder ask QUESTION \
  [--path WORKSPACE] \
  [--database PATH] \
  [--format text|json] \
  [--max-depth 2] \
  [--max-nodes 100] \
  [--diagnostics]
```

Quote the question so that the shell passes one argument. The workspace defaults
to the current directory. Select `planning.provider` as `ollama`, `claude`, or
`copilot` in the user or workspace configuration. No provider is selected by default.
The provider receives grammar, snapshot vocabulary, retrieval descriptions, and
limits, without source code by default. It returns up to three candidates in one
response. Validation, candidate agreement, and source evidence determine the answer.
There is no rule, catalog-only, or cross-provider fallback.

## Query

Execute direct constrained source without AI planning:

```bash
agent-wayfinder query [--query SOURCE | --file PATH] \
  [--path WORKSPACE] \
  [--database PATH] \
  [--format text|json] \
  [--max-depth 2] \
  [--max-nodes 100] \
  [--diagnostics]
```

Use standard input when neither source flag is supplied. `--query` and `--file`
cannot be used together. The workspace defaults to the current directory.

```bash
agent-wayfinder query --query "MATCH (node {name: 'main'}) RETURN node LIMIT 10" --format json
```

Both modes use the same constrained language, snapshot scope, validation, and
resource caps. Supported clauses are `MATCH`, `SEARCH LEXICAL`, `SEARCH VECTOR`,
`WHERE` with exact predicates, `RETURN`, `ORDER BY`, and required `LIMIT`.
Relationships are directed and paths are bounded to one through five hops.
A bare `*` defaults to one through three hops. Quote language-qualified kinds
and relations with backticks. Writes, arbitrary SQL, unbounded paths, aggregation,
subqueries, and procedure calls are rejected. Vector search requires configured
catalog embeddings.

The node cap also bounds seed, recursive path, and candidate-row work. One extra
candidate detects truncation. A warning marks incomplete execution, including
empty results. `ORDER BY` sorts only the bounded candidate set.

Results contain graph, rows, evidence, snapshot, warnings, and limits. `ask` adds
`selectedSource`, `confidence`, and `confidenceBasis`. All-empty candidates return
zero confidence and a warning; provider failure or no valid candidate returns an
error. `--diagnostics` includes SQL and parameters; default results omit SQL.
MCP `ask` accepts `question`; MCP `query` accepts `query`. Both accept optional
`workspace`, `database`, `maxDepth`, `maxNodes`, and `diagnostics`.
The old question and TERM modes have no compatibility support.

## Path

Find a shortest directed path between two node queries:

```bash
agent-wayfinder path WORKSPACE SOURCE TARGET \
  [--database PATH] \
  [--format text|json] \
  [--max-depth 8] \
  [--max-nodes 100] \
  [--project PROJECT_ID]... \
  [--relation RELATION]... \
  [--undirected]
```

The source and target are each one argument. Quote names that contain spaces. Use `--undirected` only after the directed path is absent and an undirected structural connection is useful.

## Inspect

Inspect one exact or unambiguous node and its relationships:

```bash
agent-wayfinder inspect WORKSPACE NODE [--database PATH] [--format text|json]
```

When lookup is ambiguous, the result contains up to three candidates and a remaining-candidate count. Rerun with an exact candidate ID.

## Export

Export all nodes and edges from the published snapshot:

```bash
agent-wayfinder export WORKSPACE [--database PATH] [--format text|json]
```

Use export for interoperability or full-graph inspection. Prefer bounded commands for normal agent retrieval.

## Indexer Process

Control the workspace indexer process:

```bash
agent-wayfinder indexer serve WORKSPACE [--format text|json]
agent-wayfinder indexer start WORKSPACE [--format text|json]
agent-wayfinder indexer status WORKSPACE [--format text|json]
agent-wayfinder indexer stop WORKSPACE [--format text|json]
```

`serve` runs the process in the foreground. `start` launches the same process in the background. The current CLI wiring reports lifecycle status, but it does not connect a file watcher, reconciler, or graph publisher. It does not replace `index` for graph creation or refresh. The process exits after five minutes without a status or stop request.

## Output And Errors

Text results start with the graph version and UTC publication time. JSON results use this envelope:

```json
{
  "graphVersion": 1,
  "publishedAt": "2026-08-31T00:00:00Z",
  "result": {}
}
```

An invalid argument exits with code `2`. Other failures, including an unavailable published graph, exit with code `1` and write an `error:` line to standard error.