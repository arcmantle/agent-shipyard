# Configuration

[Back to the project overview](../README.md)

## Precedence

Agent Wayfinder reads configuration in this order:

1. Built-in defaults.
2. User configuration in `~/.agent-wayfinder/config.json`.
3. Workspace configuration in `.agent-wayfinder/config.json`.
4. Environment variables.
5. Command flags.

Each later value overrides the same earlier setting. Both configuration files
use the same JSON object. Use the published schema for editor completion:

```json
{
  "$schema": "https://raw.githubusercontent.com/arcmantle/agent-wayfinder/main/schemas/config.schema.json"
}
```

## Source Selection

Patterns use TypeScript-style globs, including `**` for recursive directories.

```json
{
  "sources": {
    "include": ["src/**/*.ts", "packages/*/src/**/*.ts"],
    "exclude": ["**/*.test.ts", "**/generated/**"]
  }
}
```

An absent `include` selects all supported source files. An empty `include`
selects none. An empty `exclude` disables only configuration exclusions.
Workspace arrays replace the corresponding user arrays. Git ignore rules and
internal directories remain excluded. `.wayfinderignore` is not used.

## Question Planning

`ask` requires one provider: `ollama`, `copilot`, or `claude`. No provider is
selected by default. Configure only the provider you intend to use.

```json
{
  "planning": {
    "provider": "ollama",
    "ollama": {
      "model": "qwen3:8b",
      "endpoint": "http://127.0.0.1:11434",
      "timeout": "30s"
    },
    "copilot": {
      "model": "auto",
      "maxAiCredits": 30,
      "tokenBudget": 4096,
      "timeout": "30s"
    },
    "claude": {
      "model": "sonnet",
      "maxBudgetUsd": 0.25,
      "timeout": "30s"
    }
  }
}
```

Ollama must be running with the selected model available. Agent Wayfinder uses
its HTTP API, not its CLI. The default endpoint is `OLLAMA_HOST` when set,
otherwise `http://127.0.0.1:11434`. Planning uses an 8192-token context,
a 2048-token output limit, one host thread, and an 8 KiB response limit.
The request uses `keep_alive: 0` to unload the model when it completes.

Copilot and Claude require their respective CLIs and authentication.
Copilot uses its configured model without an automatic retry. Claude planning
does not use a fallback model. Invalid settings return an error.

```bash
awf ask "What is the application entrypoint?" --path . --format json
```

The provider receives the question, grammar, snapshot vocabulary, retrieval
capabilities, and limits without source code by default. If all valid candidates
are empty, the result has zero confidence and a warning.

## Direct Queries

Direct queries need no AI provider. Use a string, a file, or standard input:

```bash
awf query --query "MATCH (node {name: 'main'}) RETURN node LIMIT 10" --format json
awf query --file query.cypher --path . --format json
```

Both `ask` and `query` accept `--max-depth`, `--max-nodes`, and `--diagnostics`.
Diagnostics include generated SQL and parameters; default output omits SQL.
The node cap also sets seed, recursive-path, and candidate-row budgets.
One extra candidate detects truncation. Paths allow one through five hops;
a bare `*` defaults to one through three hops, subject to execution caps.

The former natural-language `query`, TERM mode, and rule planner are removed.
Use `ask` for questions and `query` for constrained graph-query source.

## Catalog

`index` starts background catalog work by default. Disable it for graph-only
indexing:

```bash
awf index --catalog-background=false /path/to/workspace
```

Catalog-unit retention is separate and off by default. Without retention,
cataloging derives units from stored snapshot facts and unchanged source files.
Source hashes are checked before catalog entries or embeddings are written.
Files changed without a matching index update must be re-indexed first.

To catalog an old snapshot after source files change, retain units at index time:

```bash
awf index --catalog-background=false --retain-catalog-units /path/to/workspace
```

Library requests omit units by default. Set `RetainCatalogUnits: true` in
`index.Request` or `index.BatchRequest` when required. Direct extractor calls
keep their existing defaults. The continuous indexer omits retained units and
schedules catalog refreshes. A refresh uses the latest snapshot when it starts;
if its queued snapshot was replaced, it uses a full pass.

### Embeddings

Embeddings are disabled by default. The default model is `qwen3-embedding:4b`.
Install and start Ollama, then download the model:

```bash
ollama pull qwen3-embedding:4b
awf index --catalog-embeddings /path/to/workspace
```

To configure embeddings for a workspace:

```json
{
  "embedding": {
    "provider": "ollama",
    "ollama": {
      "model": "qwen3-embedding:4b",
      "endpoint": "http://127.0.0.1:11434",
      "timeout": "10s"
    },
    "processLimit": 2
  }
}
```

If Ollama or the model is unavailable, indexing continues and lexical catalog
retrieval remains available. Requests use one host thread and a 4 MiB response
limit. Catalog work sends up to 32 inputs per request and uses at most two
concurrent requests. Use `processLimit: 1` on a constrained host.
The model stays loaded for a catalog pass and unloads when the pass completes.
One-off query embeddings unload it after the request.

### Synopses

Deterministic synopses always run. AI synopses are disabled by default.
An optional provider receives catalog metadata and bounded declaration source.
This can share code outside the local machine. Check the provider boundary
before you enable it.

For Ollama:

```json
{
  "synopsis": {
    "provider": "ollama",
    "sourceLimit": 8192,
    "ollama": {
      "model": "qwen3:8b",
      "endpoint": "http://127.0.0.1:11434",
      "timeout": "30s"
    }
  }
}
```

For Copilot:

```json
{
  "synopsis": {
    "provider": "copilot",
    "sourceLimit": 4096,
    "copilot": {
      "maxAiCredits": 30,
      "processLimit": 1,
      "path": "copilot"
    }
  }
}
```

An omitted Copilot model uses its configured default. `maxAiCredits` must be
at least 30. The synopsis credit cap is separate from the planning credit cap.

For Claude, set `synopsis.provider` to `claude` and configure
`planning.claude.enabled: true`, its model, timeout, and `maxBudgetUsd`.
That budget applies to both planning and synopses.

`sourceLimit` is a positive byte limit per declaration. Use
`--catalog-synopsis-provider` and `--catalog-synopsis-source-limit` for command
overrides. Copilot and Ollama also have provider-specific catalog flags.
Copilot and Claude run without tools.

Provider failures retain deterministic synopses and lexical retrieval.
Embeddings use stored synopsis text, not raw declaration source.
Unchanged units reuse the nearest catalog record valid for the requested graph
version. Changed or removed units end the validity of old records. Embeddings
can be reused when their text is unchanged. Records required by retained
snapshots remain available when their original graph version is pruned.

## Spending Limits

Set limits in the user configuration:

```json
{
  "spending": {
    "copilot": {
      "dailyAiCredits": 10000,
      "weeklyAiCredits": 50000,
      "monthlyAiCredits": 200000
    },
    "claude": {
      "dailyUsd": 100,
      "weeklyUsd": 500,
      "monthlyUsd": 2000
    }
  }
}
```

Each limit is independent. Periods use UTC days, Monday-start weeks, and
calendar months. Wayfinder reserves the maximum request amount before work
starts. An insufficient budget fails `ask` without fallback. Catalog generation
can skip the provider and retain deterministic output.

Exact provider usage replaces the reservation when available. Otherwise, the
maximum reservation remains until the period resets.

`awf copilot-metrics [WORKSPACE]` reports local daily usage and the current
UTC month's total. Use `--month YYYY-MM`, `--day YYYY-MM-DD`, or `--verbose`.
Records include model, outcome, time, token totals, byte counts, and reported
credits. They do not contain prompts, responses, source text, or credentials.
Unavailable usage remains unavailable. `costUsd` is an estimate derived from
used credits divided by 100. Old records without final usage reports are not
backfilled. `awf claude-metrics` reports local Claude planning usage.

## Indexer Commands

Use `awf indexer --help` for service controls, including `serve`, `start`,
`status`, and `stop`. Check the indexed graph version before you rely on
results. A service status alone is not evidence that a source change is indexed.

## Indexing Memory Limits

Initial extraction uses a queue with capacity 32. Completed contributions are
not retained after storage writes. Contribution batches are limited to 5,000
rows, 4 MiB, or 64 sources.

Lexical snapshot construction uses one ordered SQL cursor. It buffers at most
500 rows and 4 MiB of estimated row data, plus the current row. An oversized row
fails publication. FTS inserts also respect the SQLite variable limit.
These limits apply to initial and incremental publication, rebuilds, and
migration. The production database limit remains 4 GiB.