# Release notes

## Bounded Next-Work Candidates

`entity_next_work` now returns up to five next-in-line available issues by default. Set `limit` from one to 20 when needed. Candidates use descending unfinished-unblock count, then ascending immutable issue ID. The next-work skill selects the recommendation from the returned candidates.

The response contains `initiative`, `available`, `counts`, and `hasMore`. It no longer returns a server recommendation, blocked issue collection, dependency links, or `nextContinuation`. `hasMore` does not require another call. Total available and blocked counts distinguish completed work from blocked work. The complete CLI `next-work` report is unchanged.

## Larger MCP Responses

Bounded MCP responses now return up to 64 KiB (65536 serialized UTF-8 JSON bytes) per call, increased from 8 KiB. This applies to runtime instructions, resource bodies, metadata, collections, relations, context, initiative graphs, and next-work results.

Larger documents still use `offset` and `documentHash`. Continue until `nextOffset` is null. Paged collections retain their existing continuation fields. The separate next-work change above replaces its paging contract with a bounded candidate list.

## Fixed Entity JSON Contracts

This breaking release removes entity `--view` selection and gives each command one JSON response shape:

- `show <id> --json` returns complete entity content; `show <initiativeId> --json` returns the complete initiative graph.
- `list` and `relations` return summary projections without authored bodies.
- Mutations return compact acknowledgements.
- `list` JSON returns `{ items, total }`, where `total` is the filtered count before `--limit` is applied.
- The redundant `bundle` command is removed; use `show <initiativeId>`.
- Human-readable output is unchanged.
- `list` filters and limits, plus relation type and direction filters, execute in storage so large trackers do not fetch records that will be discarded.

Scripts that need complete entity content must use `show <id>`. Scripts that consume list or relation output must use their summary response shapes.