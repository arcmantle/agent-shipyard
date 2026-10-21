---
name: agent-wayfinder
description: "Use for codebase architecture, dependency, call-flow, impact, and project-relationship questions, and for Agent Wayfinder install, index, ask, query, path, inspect, export, or indexer tasks. Query an existing local code graph before broad source search, then verify graph evidence in current source."
argument-hint: "[question, node, path, or indexing task]"
---

# Agent Wayfinder

Use Agent Wayfinder as a local map of code structure and relationships. The graph is retrieval and planning evidence. Source code, language-server results, tests, and Git remain authoritative.

## Usage

```text
/agent-wayfinder install [--project]
/agent-wayfinder index [WORKSPACE]
/agent-wayfinder ask <question> [--path WORKSPACE]
/agent-wayfinder query --query <source> [--path WORKSPACE]
/agent-wayfinder path [WORKSPACE] <SOURCE> <TARGET>
/agent-wayfinder inspect [WORKSPACE] <NODE>
/agent-wayfinder export [WORKSPACE]
/agent-wayfinder indexer <serve|start|status|stop> [WORKSPACE]
```

If the user gives no workspace, use the repository root. If there is no repository root, use the current directory.

## Choose A Command

| Need | Command |
|---|---|
| Install this skill for the user or current project | `install` |
| Build or refresh the graph | `index` |
| Ask a natural-language architecture question | `ask` |
| Execute direct constrained graph-query source | `query` |
| Trace a directed relationship chain | `path` |
| Inspect one exact or unambiguous node | `inspect` |
| Read the complete published graph | `export` |
| Control the current indexer process | `indexer` |

Load [the command reference](./references/commands.md) when you need exact syntax, flags, installation details, or indexer limits.

## MCP Tools

When Agent Wayfinder MCP tools are available, use `ask`, `query`, `path`, `inspect`,
and `export` directly instead of launching the equivalent CLI commands. Pass
the resolved workspace path to each tool. The MCP results use the same JSON
contract as the CLI, including `graphVersion`, `publishedAt`, evidence, scope
boundaries, and truncation details.

Use the CLI when the required MCP tool is not available. Always use the CLI for
`install`, `index`, and `indexer` because the MCP server is read-only.

## Procedure

1. Resolve the workspace to an absolute repository root.
2. For `ask`, `query`, `path`, `inspect`, or `export`, use the matching MCP tool when it is available. Otherwise, prefer `agent-wayfinder`. Use `a-wayfinder` if only that alias is installed. In the Agent Wayfinder source repository, use `make run ARGS='...'` when no installed command is available.
3. Check for `<WORKSPACE>/.agent-wayfinder/graph.db`, unless the user gave `--database`.
4. If no published graph is available, run `index WORKSPACE --format json` before a graph query.
5. For questions about recent edits, refresh with `index`. Do not assume that the current `indexer start` command updates the graph.
6. For an architecture question, run `ask` with the complete sentence and JSON output before exact follow-up commands. Select one AI provider in configuration. Do not invent a query before this command runs.
7. Read the selected source, confidence, confidence basis, warnings, graph version, evidence, publication time, and limits.
8. When planning fails or evidence is weak, report the limit. Follow up with direct constrained source, `path`, `inspect`, or source search. Do not invent a fallback answer.
9. Inspect the cited source before an edit or a final technical claim. Use language-server navigation or text search for exact symbol lookup.
10. Run focused tests and inspect the Git diff after a change. A graph result is not validation.

## Query Fast Path

When a published graph exists and the user asks an architecture question, pass the complete question first:

```bash
agent-wayfinder ask "How does AuthService validate a token?" --path "$WORKSPACE" --format json
```

`ask` returns validated source and source-backed evidence. Confidence comes from
candidate agreement and executed evidence, not model self-assessment. It has no
rule, catalog-only, or cross-provider fallback. If results are empty, use source
search and state that the graph did not establish an answer.

For direct source without AI, use:

```bash
agent-wayfinder query --path "$WORKSPACE" --query "MATCH (node {name: 'AuthService'}) RETURN node LIMIT 10" --format json
```

Both modes execute bounded read queries against the published snapshot. Use
`--diagnostics` only when SQL and parameters are needed. The former question
and TERM modes are removed.

Use bounded traversal. Increase `--max-depth` or `--max-nodes` only when the result reports truncation or the first traversal stops before the needed boundary.

## Path And Inspect

Use `path` when both endpoints are known:

```bash
agent-wayfinder path "$WORKSPACE" AuthService TokenStore --format json
```

Paths are directed by default. Use `--undirected` only as an explicit fallback, and state that the result does not prove directed flow.

Use `inspect` for one node:

```bash
agent-wayfinder inspect "$WORKSPACE" AuthService --format json
```

If `inspect` returns several candidates, choose from those candidates and rerun with the exact node ID. Do not select an ambiguous node from memory.

## Evidence Rules

- Cite graph evidence with its source path and location when available.
- State the graph version and publication time when freshness matters.
- Treat scope boundaries and truncation as limits on the answer.
- Separate graph-supported facts from inference. State uncertainty when confidence is low, warnings are present, or evidence is incomplete.
- Inspect current source before you make a technical claim. A source span is a location to verify, not a source excerpt.
- Do not invent missing edges or treat an undirected fallback as call direction.
- Do not read the complete export when a bounded query, path, or explanation can answer the question.