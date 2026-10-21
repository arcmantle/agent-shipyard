# Shared Skill Operating Contract

All bundled `ai-*` skills follow this contract. They also follow the shared [language standard](./agent-issues-language.md).

## Tracker is canonical

`agent-issues` is the single tracker for work. A chat plan, a scratch note, a raw markdown document, and a test file are not work records.

- Use the exact operation recipe named by the active skill. Start with its MCP tool. Use the listed CLI fallback only when the MCP server is unavailable or lacks that operation.
- Before you plan, implement, migrate, or hand off work, run the **Entity Read** recipe, the **Relation Query** recipe, and the **Context Read** recipe to find the active tracked scope.
- Do not leave a new initiative, ADR, or implementation follow-up untracked. Run the **Entity Create And Edit** recipe to create the missing record when its parent is clear. If not, ask one routing question.
- For new feature planning, create a new initiative by default. Reuse an existing initiative only when the user asks for that directly.
- A Plan is required for every planning effort. Resolve an explicit Plan reference first. If it is unavailable in the current tracker scope, report that fact, then select an existing Plan under the active initiative or create a replacement Plan there. Do not use the unavailable reference for Plan-entry operations.
- Run the **Entity State And Structure** recipe to change issue status and Plan status. Derive user story and PRD status from their linked issues. An ADR is `current` unless it is `superseded` or `archived`.
- Treat each entity's complete `reference` field as its public tracker identity. Copy it exactly as returned by the tracker whenever you report or use an entity. Never abbreviate or truncate it, and never replace it with the internal `id`.

Issue comments use complete `COM_` references. They are issue discussion, not tracker state: use tracker records for scope, decisions, blockers, handoffs, and status.

## Operation Recipes

Every tracker operation uses one of these recipes. CLI fallbacks use `--json`.

**Kind** is `Read`, `Write`, `Destructive write`, or `Host`. A `Read` recipe does not change tracker data. A `Write` recipe changes tracker data. A `Destructive write` recipe requires the stated inspection or confirmation flow. A `Host` recipe changes the local environment and has no MCP equivalent.

### Entity Read

**Kind:** Read.

- MCP: `resource_show({ request: { resource: "entity", reference } })`.
- CLI fallback: `agent-issues show <reference> --json`.
- MCP returns `entity` metadata and `reads` references for every entity kind. It does not return the body, relations, comments, or an initiative graph. A successful serialized response is at most 65536 UTF-8 JSON bytes.
- Use `reads.body.tool` and `reads.body.arguments` for the **Entity Body Read** recipe. Use `reads.relations` for the **Relation Query** recipe. `reads.details` gives the complete CLI detail command and arguments.
- If metadata exceeds the response budget, the tool returns an error with the canonical reference and read references, not partial metadata. Use `reads.details` for complete details. Run a CLI fallback with the same project, tenant, and database selection as the MCP session.
- For complete Markdown through MCP, use the **Entity Body Read** recipe. Use an explicit **Initiative Read** for initiative-wide scope.

### Resource Metadata Read

**Kind:** Read.

- MCP: `resource_show({ request })`. Select one supported resource variant:
	- `resource: "entity"` with `reference` for entity metadata.
	- `resource: "planEntry"` with `entryId` and optional `view: "summary"` for current Plan-entry metadata. Use `view: "details"` with optional `revision`, `offset`, and `documentHash` for complete metadata in bounded JSON parts.
	- `resource: "context"` with optional `scopeRef` for context metadata and term summaries. Omit scope for global context.
	- `resource: "contextTerm"` with `term` and optional `scopeRef` for one term's metadata.
	- `resource: "instructionSource"` with `key` for the current owner's source metadata at the running CLI release.
	- `resource: "issueBreakdown"` with `action: "show"` and `draftId`, or `action: "latest"` and `targetId`, for stored draft metadata.
- Follow returned `reads.body` references for complete text and `reads.details` for complete metadata or CLI details. Context term summaries provide their own read references. Draft metadata retains the stored draft and snapshot identities; its complete issue specifications remain available through the returned CLI detail read.
- Metadata reads do not return authored bodies or implicitly load an initiative graph. Use **Resource Body Read**, **Relation Query**, and **Initiative Read** explicitly. Runtime loaders continue to use `instruction_retrieve`.
- Requests reject unsupported resource combinations before storage access. Reads use the same authorization, tenant, workspace, and instruction-owner selection as other MCP operations. Keep that selection when using a complete CLI detail read.

### Entity Body Read

**Kind:** Read.

- MCP: `resource_body({ request: { resource: "entity", entityId, revision?, offset?, documentHash? } })`.
- CLI fallback: `agent-issues show <reference> --json`, or `agent-issues history <reference> --revision <revision> --json` for a historical body.
- Omit `revision` for the current body. Set it for a historical body. The first call needs no offset or hash.
- The first text block contains JSON metadata: `reference`, `revision`, `documentHash`, `offset`, and `nextOffset`. The second contains Markdown. Responses do not duplicate the body in `structuredContent`.
- Each response is at most 65536 UTF-8 JSON bytes. If `nextOffset` is not null, call again with the same entity, selected revision, and hash, using the returned `nextOffset` as `offset`. Copy returned offsets; do not calculate them.
- Read all parts in order before use. Join the Markdown parts without separators. A null `nextOffset` means complete, including an empty body.
- A changed current revision or a different entity or selected revision invalidates the hash. Discard all parts and restart without offset and hash. Invalid offsets, missing continuation hashes, and unavailable bodies return errors without partial Markdown. Do not use local files or shell commands to complete an MCP body read.

### Resource Body Read

**Kind:** Read.

- MCP: `resource_body({ request })`. This is the shared read-only tool for complete resource text. Use the resource variant and its identifiers:
	- `resource: "entity"` with `entityId` for an entity body.
	- `resource: "planEntry"` with `entryId` for a Plan-entry body.
	- `resource: "context"` with optional `scopeRef` for a context summary.
	- `resource: "contextTerm"` with `term` and optional `scopeRef` for a term definition.
	- `resource: "comment"` with `commentId` for a comment body.
	- `resource: "instructionSource"` with `key` for unexpanded instruction-source Markdown.
- Put optional `revision`, `offset`, and `documentHash` inside `request`. Omit revision for current text. Retain a selected historical revision on every call.
- The first text block contains metadata with resource kind, canonical reference, revision, tenant, scope, document hash, offset, and next offset. Instruction-source metadata also identifies the owner, requesting release, and source revision. The second block contains Markdown. Each serialized response is at most 65536 UTF-8 JSON bytes, with no duplicated body in `structuredContent`.
- Copy `nextOffset` into `request.offset` with the same resource identifiers, revision, and returned `documentHash` until it is null. Read all parts in order and join them without separators. Do not calculate offsets. An empty body is complete in one part.
- On a changed document, discard all parts and restart without offset and hash. Invalid resource combinations, offsets, hashes, or unavailable revisions return errors without partial text. Hashes cannot be exchanged across resource kinds, tenants, workspace scopes, or instruction owners.
- Instruction source reads do not expand fragments. Continue to use `instruction_retrieve` for complete assembled skill and agent instructions. Runtime loaders must not use `resource_body`.
- CLI fallback: use the owning resource's complete read command from the matching recipe. Keep the same project, tenant, and database selection. Storage and CLI semantics are unchanged.

### Resource Collection Read

**Kind:** Read.

- MCP: `resource_list({ request })`. Put the resource kind and its required identifiers inside `request`.
- Supported requests: `resource: "entity"` with required `kind` and optional `statuses`, `parentId`, and `limit`; `resource: "orphanEntity"` with optional `kind`; `resource: "planEntry"` with required `planId`; `resource: "context"` with `view: "list"` or `view: "directory"`; `resource: "comment"` with required `issueId`; `resource: "instructionSource"`; and `resource: "tenant"`.
- Entity, orphan, Plan-entry, context, instruction-source, and tenant pages return `nextContinuation`. Copy it into `request.continuation` with the same request until it is null. Comment pages return `nextBefore`; copy it into `request.before` and prepend older pages.
- Instruction catalogs return `version`, `items`, and `nextContinuation`. Items use ascending stable-key order and exclude source bodies. Follow each item's body or CLI detail read for complete source. Instruction continuation also binds the owner and requesting CLI release.
- Each existing bounded summary response is at most 65536 serialized UTF-8 JSON bytes. Complete bodies and metadata remain available through returned read references. Pages are live reads, not snapshots.
- Continuation is bound to the resource kind, selected operation or view, tenant, workspace/project, filters, limits, order, and server process. Cross-resource reuse, changed requests, and invalid tokens return errors without a page.
- CLI fallback: use the matching collection command, including `agent-issues orphans [--kind <kind>] --json`, `agent-issues tenant list --json`, and `agent-issues instruction list --json`. Keep the same scope and database selection.

### Entity List

**Kind:** Read.

- MCP: `resource_list({ request: { resource: "entity", kind, statuses?, parentId?, limit?, continuation? } })`.
- CLI fallback: `agent-issues list <kind> [--status <status[,status]>] [--parent <parent>] [--limit <count>] --json`.
- MCP returns `entities` summaries and `nextContinuation`. Each serialized response is at most 65536 UTF-8 JSON bytes. `limit` is a maximum item count per page, not a limit on the complete traversal.
- Start without `continuation`. Copy each non-null `nextContinuation` into the next call with the same request. A null `nextContinuation` means complete, including an empty result. Do not calculate continuation values.
- Summaries use ascending immutable entity ID order. Use each summary's `reads.body` for complete Markdown and `reads.details` for complete CLI details. Large bodies are not part of the list.
- Continuation is bound to the resource kind, list operation, tenant, project, filters, item limit, fixed order, and MCP server process. Invalid continuation, a changed request, or a server restart requires a new traversal. Oversized single summaries return a bounded error with a complete CLI detail command, not a partial page or an empty-page loop.
- Each page reads current data; the traversal is not a snapshot. Inserts and deletes before the last ID do not shift later pages. Records at or before that ID are not revisited. Later records appear only if they still match the filters, with their current metadata. Restart the traversal to include changes behind that ID.
- Keep the same project, tenant, and database selection when you use the CLI fallback. Complete CLI reads retain their existing behavior.

### Relation Query

**Kind:** Read.

- MCP: `relation_query({ entityId, direction?, types?, continuation? })`.
- CLI fallback: `agent-issues relations <entityId> [--direction <incoming|outgoing|both>] [--type <type[,type]>] --json`.
- MCP returns entity identity, `incoming` and `outgoing` relation summaries, linked `planEntries` summaries, and `nextContinuation`. Each serialized response is at most 65536 UTF-8 JSON bytes. Bodies are not part of these pages. Plan provenance retains the storage contract: it is included independently of entity-relation direction and type filters.
- Start without `continuation`. Copy each non-null `nextContinuation` into the next call with the same request. A null `nextContinuation` means complete, including an empty result. Join each summary section across all pages before you use the complete result. Do not calculate continuation values.
- Summary keys use ascending JSON-encoded tuples of section, relation type, and immutable related-item ID. Sections are `incoming`, `outgoing`, and `planEntries`; Plan provenance uses `informs` as its key type. The tool selects page size from the byte budget.
- Continuation is bound to the resolved entity, tenant, workspace/project scope, direction, normalized type filters, fixed order, and MCP server process. Invalid continuation, changed scope or filters, or a server restart requires a new traversal.
- Each page reads current data, not a snapshot. Inserts and deletes before the last key do not shift later pages. Keys at or before that key are not revisited. Later matching links use their current metadata. Restart to include changes behind the cursor.
- Use **Resource Metadata Read** with `resource: "entity"` for related entity metadata and **Resource Body Read** for complete Markdown. Plan-entry summaries provide body and complete detail read references. An oversized single summary or link collection returns a bounded error with a detail reference, not silent omission or an empty-page loop.
- Keep the same project, tenant, and database selection when you use the CLI fallback. Complete CLI relation reads retain their existing behavior.

### Initiative Read

**Kind:** Read.

- MCP: `initiative_bundle({ initiativeId, continuation? })`.
- CLI fallback: `agent-issues show <initiativeId> --json`.
- Use this operation explicitly for the initiative graph. `resource_show` does not load or return the bundle. Complete CLI initiative reads remain unchanged.
- Each response contains initiative metadata, bounded summary sections, and `nextContinuation`, within 65536 serialized UTF-8 JSON bytes. Start without continuation. Copy each non-null `nextContinuation` into the same request until it is null. Join every section across pages before you use the complete graph, including `entities`, `prds`, `userStories`, `adrs`, `issues`, `fixLinks`, `subIssueLinks`, `blockerLinks`, `constrainsLinks`, and `versionCoverage`.
- Entity and relation endpoints are summaries, not authored bodies. Follow their `reads.body` references through **Resource Body Read** for complete Markdown. Oversized single metadata returns a bounded error with a complete CLI detail command, not a partial page.
- Keys use section names and stable record identities. Continuation is bound to the initiative, tenant, workspace/project, operation, order, and MCP server process. Invalid continuation or a changed request requires a new traversal.
- Pages read current data, not a snapshot. Keys at or before the cursor are not revisited. Later keys use current records; removed links disappear. Restart to include changes behind the cursor. Keep the same project, tenant, and database selection for CLI fallback.

### Next Work

**Kind:** Read.

- MCP: `entity_next_work({ scopeId, limit? })`.
- CLI fallback: `agent-issues next-work <initiativeOrDescendantId> --json`.
- The operation resolves the requested scope to its owning initiative. It returns up to five next-in-line candidates by default. Set `limit` from one to 20 only when a different candidate count is needed.
- Each response is within 65536 serialized UTF-8 JSON bytes and contains `initiative`, `available`, `counts`, and `hasMore`. `counts.available` and `counts.blocked` are initiative-wide totals. `hasMore` means that other available issues exist outside the returned list. There is no continuation, server recommendation, blocked collection, or dependency link collection.
- Candidates use descending `unfinishedUnblockCount`, then ascending immutable issue ID. Each candidate contains issue summary metadata, body-read references, and its unfinished-unblock count. Availability and parent-child blocker rules remain unchanged.
- The calling skill chooses the recommendation from these candidates. Follow finalist body-read references only when authored outcomes are needed for comparison. Do not read every available issue or increase the limit only because `hasMore` is true.
- Zero available issues with a positive blocked count means blocked work. Both counts at zero mean that no unfinished, non-deferred issues remain. Use explicit entity and relation reads for blocker diagnostics when needed.
- Reads use current work state, not a snapshot. Read again after work-state changes. Invalid limits and oversized responses return errors without partial candidates. The complete CLI report remains unchanged; keep the same project, tenant, and database selection for fallback.

### Context Read

**Kind:** Read.

- MCP: `resource_show({ request: { resource: "context", scopeRef? } })`, `resource_list({ request: { resource: "context", view: "directory", continuation? } })`, `context_search({ query?, view? })`, or `context_conflicts({ query?, view? })`.
- Use **Resource Metadata Read** with `resource: "contextTerm"`, `term`, and optional `scopeRef` for one term. Follow returned body references to read context summaries and term definitions in full before use.
- Collection MCP reads: `resource_list({ request: { resource: "context", view: "list" | "directory", continuation? } })` and `context_search({ query?, view?, continuation? })`. Each serialized response is at most 65536 UTF-8 JSON bytes. Start without continuation. Copy each non-null `nextContinuation` into the same request until it is null. For `resource_list`, put continuation inside `request`. Join every collection section across pages before use. In directory and search results, retain the non-null `shared` section and append `initiatives`, `terms`, and `duplicateTerms`.
- List pages contain context metadata and term counts. Directory and search pages contain context metadata and term-source summaries, not context bodies or definitions. Follow each `reads.body` reference through **Resource Body Read** for complete text. Keep the selected revision and scope from the reference. Complete CLI reads remain unchanged.
- Lists use ascending immutable context-key order. Directory and search use ascending JSON tuples of section and context key or normalized term, with term spelling as a tie-breaker. Continuation is bound to the operation, tenant, workspace/project, trimmed query, view, fixed order, and MCP process. Invalid continuation or changed request parameters require a new traversal.
- Pages are live reads, not a snapshot. Keys at or before the cursor are not revisited. Later matches use current metadata; removed records disappear. Restart to include changes behind the cursor. A single oversized summary or request returns a bounded error with a complete CLI detail command, not partial data or an empty-page loop.
- CLI fallback: `agent-issues context show [<scope>] --json`, `agent-issues context list --json`, `agent-issues context search <query> [--view <all|global|initiatives>] --json`, or `agent-issues context conflicts [<query>] [--view <all|initiatives>] --json`.

### Context Write

**Kind:** Write.

- MCP: `resource_create({ request: { resource: "context", scopeRef?, title, summary, expectedRevision?, expectedContentHash? } })`, `context_term_define({ scopeRef?, term, definition, avoid?, expectedRevision?, expectedContentHash? })`, or `resource_delete({ request: { resource: "contextTerm", action: "delete", scopeRef?, term, expectedRevision?, expectedContentHash? } })`.
- CLI fallback: `agent-issues context set --scope <scope> --title "<title>" --body-file - --json`, `agent-issues context define "<term>" --scope <scope> --body-file - [--avoid "<term[,term]>"] --json`, or `agent-issues context forget "<term>" --scope <scope> --json`.

### Entity Create And Edit

**Kind:** Write.

- MCP create: `resource_create({ request: { resource: "entity", kind, title, body?, parentId?, status?, category?, priority?, type?, links? } })`.
- MCP edit: first use the **Entity Read** recipe, then call `resource_edit({ request: { resource: "entity", entityId, title?, body?, category?, priority?, type?, expectedRevision, expectedContentHash } })`.
- CLI fallback: `agent-issues create <kind> --title "<title>" [--parent <parent>] --body-file - --json`, or `agent-issues edit <entityId> [--title "<title>"] --body-file - --json`.

### Entity State And Structure

**Kind:** Write.

- MCP: `entity_status({ entityId, status })`, `entity_move({ entityId, newParentId })`, or `entity_archive({ entityId })`.
- CLI fallback: `agent-issues status <entityId> <status> --json`, `agent-issues move <entityId> <newParentId> --json`, or `agent-issues archive <entityId> --json`.

### Entity Relations

**Kind:** Write.

- MCP: `relation_link({ fromId, relationType, toId })` or `relation_unlink({ fromId, relationType, toId })`.
- CLI fallback: `agent-issues link <fromId> <relationType> <toId> --json` or `agent-issues unlink <fromId> <relationType> <toId> --json`.
- For dependencies, `A blocks B` means B cannot start until A is done. The blocker is the source and the blocked issue is the target. If B is blocked by A, link A with `blocks` to B.

### Plan Entry Read

**Kind:** Read.

- MCP: `resource_list({ request: { resource: "planEntry", planId, continuation? } })` or `resource_history({ request: { resource: "planEntry", action: "list", entryId, continuation? } })`.
- Both operations return summaries and `nextContinuation` within 65536 serialized UTF-8 JSON bytes. Start without continuation. Copy each non-null `nextContinuation` into the next call with the same request until it is null. Join pages before using the complete result. Do not calculate continuation values.
- Lists use ascending immutable entry ID order. History uses ascending revision order. Summaries retain identity, role, lifecycle state, revision, and linked-record references. Bodies are separate. Use each summary's `reads.body` and `reads.details` for complete body and metadata reads.
- Continuation is bound to the resolved Plan or entry, tenant, workspace/project, fixed order, and MCP server process. Invalid continuation, changed scope, or a server restart requires a new traversal. A single oversized summary or link collection returns a bounded error with a complete detail reference, not partial data or an empty-page loop.
- Pages read current data, not a snapshot. Earlier IDs or revisions are not revisited. Later entries use current metadata; new history revisions can appear, and `headRevision` can change. Restart to include changes behind the cursor. These reads do not change Plan confirmation or issue-breakdown approval snapshots.
- CLI fallback: `agent-issues plan-entry list <planId> --json` or `agent-issues plan-entry history <entryId> --json`.

### Plan Entry Detail Read

**Kind:** Read.

- MCP: `resource_body({ request: { resource: "planEntry", entryId, revision?, offset?, documentHash? } })` for Markdown, or `resource_show({ request: { resource: "planEntry", view: "details", entryId, revision?, offset?, documentHash? } })` for complete metadata, including link and supersession collections. Omit `view`, or set `view: "summary"`, for current summary metadata and read references.
- The first text block is part metadata. The second is content. Each response is at most 65536 serialized UTF-8 JSON bytes and does not duplicate content in `structuredContent`. Omit revision for current content, or retain the selected revision from a summary on every call.
- Start without offset and hash. Copy `nextOffset` into `request.offset` with the same resource, view, entry, revision, and returned hash until `nextOffset` is null. Read all parts in order. Join content without separators. For metadata, parse the joined JSON only after the last part. Do not calculate offsets.
- Invalid offsets, unavailable revisions, and changed documents return errors without partial content. If the hash changes, discard all parts and restart without offset and hash. Body and metadata hashes cannot be exchanged.
- CLI fallback: use the complete Plan-entry list or history command from **Plan Entry Read**, with the same project, tenant, and database selection.

### Plan Entry Write

**Kind:** Write.

- MCP: `resource_create({ request: { resource: "planEntry", planId, role, body, scopeDirection?, referencedEntityIds?, supersededEntryIds? } })`, `resource_edit({ request: { resource: "planEntry", entryId, body, expectedRevision, expectedContentHash } })`, or `resource_delete({ request: { resource: "planEntry", action: "delete", entryId, expectedRevision, expectedContentHash } })`.
- CLI fallback: `agent-issues plan-entry add <planId> --role <role> --body-file - [--scope-direction <included|excluded>] [--reference <entity>] [--supersedes <entry>] --json`, `agent-issues plan-entry edit <planId> <entryId> --body-file - --json`, or `agent-issues plan-entry delete <planId> <entryId> --json`.

### Plan Entry Issue Link

**Kind:** Write.

- MCP: `plan_entry_entity_link({ entryId, targetId })` or `plan_entry_entity_unlink({ entryId, targetId })`.
- CLI fallback: `agent-issues link <planEntryId> informs <targetId> --json` or `agent-issues unlink <planEntryId> informs <targetId> --json`.
- The target must be an active entity in the current project.

### Issue Breakdown

**Kind:** Write.

- MCP create: `issue_breakdown_create({ targetId, issues })`.
- MCP read: `resource_show({ request: { resource: "issueBreakdown", action: "show", draftId } })` or `resource_show({ request: { resource: "issueBreakdown", action: "latest", targetId } })`. These return metadata and a complete CLI detail reference, not issue specifications.
- MCP preview: `issue_breakdown_preview({ draftId })`.
- MCP approve: `issue_breakdown_approve({ draftId, snapshotDigest })`.
- CLI fallback: `agent-issues issue-breakdown create <targetId> --input-file <path> --json`, `agent-issues issue-breakdown show <draftId> --json`, `agent-issues issue-breakdown latest <targetId> --json`, or `agent-issues issue-breakdown approve <draftId> --snapshot-digest <digest> --json`.
- Each proposed issue requires `key`, `title`, `outcome`, `workMode`, `scope`, `acceptanceCriteria`, and `relationReferences`. `parentKey` is optional.
- Use optional `planEntryIds` to identify the active Plan entries that inform each proposed issue. Approval creates these `informs` links with the issue graph in one transaction.
- For a proposed `blocks` relation, place the relation reference on the blocker and set its target to the blocked issue. Before draft creation, express every dependency as `blocker -> blocked` and verify that each dependent has the required incoming blockers.
- Creating a draft does not create issue records. Approval creates the complete graph only when the digest matches the reviewed snapshot.

### Plan Preview

**Kind:** Write.

- MCP preview: `plan_preview({ planId })`.
- MCP confirm: `plan_confirm({ planId, snapshotDigest })`.
- CLI fallback: unavailable. Use the MCP tools.

### Issue Comment Read

**Kind:** Read.

- MCP list: `resource_list({ request: { resource: "comment", issueId, before?, all? } })`. Copy `nextBefore` into `request.before` with the same issue until it is `null`. Each page returns the newest remaining comments in ascending creation-time and reference order. Prepend older pages to retain chronological order. `total` is the current issue-wide count. `all` cannot disable MCP paging.
- MCP history: `resource_history({ request: { resource: "comment", action: "list", commentId, continuation? } })`. Copy `nextContinuation` into `request.continuation` with the same comment until it is `null`. Append pages in ascending revision order.
- Both operations return summaries within 65536 serialized UTF-8 JSON bytes. Bodies are separate. A single oversized summary returns an error, not a partial page. Complete CLI metadata reads remain available.
- Continuation is bound to the issue or comment, tenant, workspace/project, and MCP server process. Invalid continuation returns an error with no page. Pages are live reads, not a snapshot. New comments newer than the list cursor are not revisited. Edits use current metadata. New history revisions after the cursor can appear, and `headRevision` can change.
- CLI fallback: `agent-issues comment list <issueId> [--before <cursor>] [--all] --json` or `agent-issues comment history <commentId> --json`.

### Issue Comment Body Read

**Kind:** Read.

- MCP: `resource_body({ request: { resource: "comment", commentId, revision?, offset?, documentHash? } })`. Use the body-read reference from a summary to retain its selected revision. Omit `revision` to read the current body.
- The first text block is JSON metadata. The second is Markdown. Copy `nextOffset` into `offset` with the same comment, revision, and returned `documentHash` until `nextOffset` is `null`. Read all parts before use. Do not calculate offsets.
- If the document changes, discard all parts and restart without `offset` and `documentHash`. Invalid offsets, unavailable revisions, and mismatched hashes return an error with no body.
- CLI fallback: use the complete comment list or history read from **Issue Comment Read**.

### Issue Comment Write

**Kind:** Write.

- MCP: `resource_create({ request: { resource: "comment", issueId, body, referencedIssueIds? } })`, `resource_edit({ request: { resource: "comment", commentId, body, referencedIssueIds?, expectedRevision, expectedContentHash } })`, or `resource_delete({ request: { resource: "comment", action: "delete", commentId, expectedRevision, expectedContentHash } })`.
- CLI fallback: `agent-issues comment add <issueId> --body-file - [--reference <issue>] --json`, `agent-issues comment edit <issueId> <commentId> --body-file - [--reference <issue>] --json`, or `agent-issues comment delete <issueId> <commentId> --json`.

### Revision Read

**Kind:** Read.

- MCP: `resource_history({ request })`. Select one supported revision operation:
	- `resource: "entity"`, `action: "revision"`, `entityId`, and `revision` for selected entity metadata.
	- `resource: "context"`, `action: "revision"`, optional `scopeRef`, and `revision` for selected context metadata.
	- `resource: "contextTerm"`, `action: "revision"`, optional `scopeRef`, `term`, and `revision` for selected term metadata.
	- `resource: "instructionSource"`, `action: "list"`, `key`, and optional `continuation` for saved source revision summaries in ascending revision order.
	- `resource: "instructionSource"`, `action: "revision"`, `key`, and `revision` for selected source metadata.
- Comment and Plan-entry revision lists use the **Issue Comment Read** and **Plan Entry Read** recipes. Other resource kinds do not provide revision lists. Unsupported requests fail before storage opens.
- Selected revisions return metadata and `reads.body` references, not historical text. Follow the registered `resource_body` reference with its selected revision. Retain target and head revision meanings, canonical references, and lifecycle state. Instruction source remains unexpanded; runtime loaders continue to use `instruction_retrieve`.
- Paged histories use continuation bound to resource kind, action, identity, tenant, workspace/project, order, and server process. Instruction histories also bind the owner and requesting CLI release. Keep the request unchanged and copy `nextContinuation` into `request.continuation` until null. Each history page is at most 65536 serialized UTF-8 JSON bytes. Histories are live reads, not snapshots. Later revisions can appear; earlier revisions are not revisited. Oversized summaries and invalid continuation return errors without a page.
- CLI fallback: `agent-issues history <entityId> --revision <revision> --json`, `agent-issues history --context <scope> --revision <revision> --json`, or `agent-issues history --context <scope> --term <term> --revision <revision> --json`.
- Instruction CLI fallback: `agent-issues instruction history <key> --json` or `agent-issues instruction revision <key> --revision <revision> --json`. Keep the same tenant, workspace, database, and owner selection.
- Use **Resource Body Read** for complete historical Markdown in bounded parts. Keep the selected revision on every continuation request. Restore operations and writes remain separate.

### Instruction Inspect

**Kind:** Read.

- MCP comparison: `instruction_inspect({ request: { action: "compare", key, offset?, documentHash? } })`. The first text block contains metadata with `format: "json"`. The second contains a JSON text part. Copy `nextOffset` into `request.offset` with the same key and hash until null. Join text parts without separators, then parse the complete JSON. Each response is at most 65536 serialized UTF-8 JSON bytes.
- Comparison includes complete current and default sources, differences, and release information. Its hash binds the owner, scope, CLI release, and selected source snapshots. On changed sources or an invalid continuation, discard all parts and restart without offset and hash. Do not use incomplete JSON.
- MCP dependencies: `instruction_inspect({ request: { action: "dependencies", key, continuation? } })`. Copy `nextContinuation` into `request.continuation` with the same key until null. Join `dependencies`, `affectedInstructions`, and `modifiedFragments` across pages. Order is the JSON tuple of section and stable item key.
- Dependency pages are at most 65536 serialized UTF-8 JSON bytes. Continuation binds the action, key, owner, CLI release, tenant, workspace/project, order, and server process. Pages are live reads, not snapshots. Earlier keys are not revisited; later keys use current data. Invalid tokens and oversized summaries return errors without a page. Use the complete CLI detail read if a single summary exceeds the budget.
- CLI fallback: `agent-issues instruction compare <key> --json` or `agent-issues instruction dependencies <key> --json`. Keep the same tenant, workspace, database, and owner selection. These complete CLI reads are unchanged.
- Pending preview remains `instruction_inspect({ request: { action: "preview", key, changes } })`. Runtime instruction loaders continue to use `instruction_retrieve`; its offset and hash contract is unchanged.

### Entity Restore

**Kind:** Destructive write.

- MCP: first call `entity_restore_inspect({ entityId, revision })`, then call `entity_restore({ entityId, revision, confirmationToken })` with its token.
- CLI fallback: `agent-issues restore <entityId> --revision <revision> --json`.

### Context Restore

**Kind:** Destructive write.

- MCP: unavailable.
- CLI fallback: `agent-issues restore --context <scope> --revision <revision> --json` or `agent-issues restore --context <scope> --term <term> --revision <revision> --json`.

### Handoff Read

**Kind:** Read.

- MCP: `resource_list({ request: { resource: "entity", kind: "handoff" } })`, `relation_query({ entityId: handoffId, direction: "outgoing", types: ["handsOff"] })`, then `resource_show({ request: { resource: "entity", reference: handoffId } })` and its body read.
- CLI fallback: `agent-issues list handoff --json`, `agent-issues relations <handoffId> --direction outgoing --type handsOff --json`, then `agent-issues show <handoffId> --json`.

### Handoff Write

**Kind:** Write.

- MCP: `resource_create({ request: { resource: "entity", kind: "handoff", title, body, links: [{ relationType: "handsOff", targetId: focusId }] } })`.
- CLI fallback: `agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId> --json`.

### Host Operations

**Kind:** Host.

These operations have no MCP equivalent. Use the Copilot or Claude Code plugin manager for plugin lifecycle operations. Use the Agent Plugins view in VS Code to enable, disable, inspect, or uninstall plugins. Use `agent-issues site` for the local site lifecycle.

## Record body recipes

Before you create or replace authored body content, identify the record type and read its matching recipe from the catalog below.

<!-- include:fragment/recipes/readme -->

- When the catalog has a recipe for the record type, use that recipe for the body. This applies to context summaries, context terms, entities, handoffs, issue comments, and Pioneer records.
- Do this before the **Entity Create And Edit** recipe, **Context Write** recipe, **Plan Entry Write** recipe, **Issue Comment Write** recipe, or **Handoff Write** recipe creates or replaces a body.
- Tracker actions that do not create or replace a body do not need a recipe.

## Current contracts replace obsolete tests

Do not keep old behavior or compatibility paths only because an old test expects them. When the active issue or a relevant ADR replaces behavior, update or remove the old implementation and its tests. Keep them only when a current compatibility or migration requirement says so.

## Resolve scope efficiently

Use compact, server-selected reads for routine discovery and graph navigation:

- Run the **Entity List** recipe to find candidates by kind. Narrow by status, parent, or limit when the scope is known.
- Run the **Relation Query** recipe with direction and type filters when the skill needs a specific edge set.
- Run the **Entity Read** recipe only when the skill needs an authored body or full stored record.
- Run the **Initiative Read** recipe only for a planned initiative-wide view. Do not use it for routine discovery or blocker checks.
- Prefer the structured MCP result directly. Do not parse presentation text or add downstream filtering that an MCP input can express.

To resume work, run the **Handoff Read** recipe.

## Context is database-backed

The canonical glossary lives in the `agent-issues` database. Do not treat a raw `CONTEXT.md` or `CONTEXT-MAP.md` file as a source of truth.

- Run the **Context Read** recipe before you use project-specific terms.
- Run the **Context Read** recipe with its search or conflict input for project-wide discovery and before you standardize an ambiguous term.
- Run the **Context Write** recipe to create missing project or initiative context with authored title and body content.
- Run the **Context Write** recipe to save resolved terms right away or remove obsolete terms when the current glossary replaces them.
- Keep the shared context free of implementation detail. It is a glossary, not a specification and not a scratch pad.

## Referenced instruction documents

Local Markdown links are references, not includes. When a linked document is required, use `instruction_retrieve` to read it from the database. Do not assume that the installed plugin contains its source file.

Instruction retrieval returns bounded parts, not a structured tracker result. The first text block contains JSON metadata. The second contains Markdown. If `nextOffset` is not null, call `instruction_retrieve` with the same `key` and `documentHash`, with `nextOffset` as `offset`. Copy the returned offset; do not calculate it. Continue until `nextOffset` is null. Read all parts in order before use. Check that all parts have the same `documentHash` and `version`. Required fragments are already included. Do not use shell commands or local files to retrieve instructions. If the document changes, discard all parts and restart with `key` only. On another failure, stop and report it. Do not use cached, bundled, or older-default instructions as a fallback.

Use the exact key from the linked document's **Referenced Instruction Keys** section. Each section names its source instruction. Do not resolve a relative link from the skill that included that source. Do not remove a directory or change its spelling. For example, `./CONTEXT-FORMAT.md` in `skill/domain-modeling` uses `fragment/domain-modeling/context-format`, not `fragment/context-format` or `fragment/domain-modelling/context-format`.

Use a fragment key for a supporting document. The key is its path relative to the canonical `skills` directory, without `.md`, in lowercase. For example, read the issue recipe with `instruction_retrieve({ "key": "fragment/recipes/issue" })` and TDD test guidance with `instruction_retrieve({ "key": "fragment/tdd/tests" })`. Use `skill/<name>` for another skill. If no key table is present, use **Resource Collection Read** with `resource: "instructionSource"` to find the exact key before retrieval. Do not guess a key from a filename.

## Preserve continuity

When work must resume in another session, run the **Handoff Write** recipe to create a graph entity that targets the active issue, user story, PRD, ADR, or initiative. Do not create a sidecar handoff file.