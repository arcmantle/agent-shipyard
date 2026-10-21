---
name: migrate-docs
description: Migrates existing project documentation into tracked agent-issues records and relationships. Use when you import or backfill PRDs, ADRs, glossary docs, planning notes, or issue lists into agent-issues.
disable-model-invocation: true
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Migrate Docs

Existing markdown docs, tickets, and notes are source material. Interpret them. Do not treat them as the final source of truth.
Use the [Context Summary](../recipes/context-summary.md), [Context Term](../recipes/context-term.md), [Initiative](../recipes/initiative.md), [PRD](../recipes/prd.md), [User Story](../recipes/user-story.md), [ADR](../recipes/adr.md), and [Issue](../recipes/issue.md) recipes when you create or edit those record bodies.

## Process

### 1. List the source material

- Find the specific documents or notes the user wants to migrate.
- Classify each source: glossary or context, initiative or roadmap, PRD or spec, ADR, or issue or task breakdown.

### 2. Map source docs to tracked entities

- Initiative or roadmap doc: create or reuse one `initiative`.
- PRD or feature spec: create or reuse one `prd` under the initiative.
- Numbered user commitments inside a PRD: create one `userStory` child for each committed story.
- ADR or architecture decision doc: create or reuse one `adr` under the initiative.
- Task list, checklist, or backlog doc: create one `issue` for each slice you can grab independently.
- Glossary, terminology, or domain-language notes: migrate into initiative-scoped context records.

If one document mixes more than one concern, split it into the smallest set of tracked records that keeps the original intent.

### 3. Publish records in dependency order

1. Create or reuse the parent initiative.
2. Migrate glossary and context terms.
3. Run the **Entity Create And Edit** recipe to create or reuse PRDs with their migrated markdown as direct body text. If you reuse an existing PRD, update its body.
4. Run the **Entity Create And Edit** recipe to create the PRD's user stories with the PRD as parent. Keep the full committed story text in the body, even when the title is shorter. If you reuse a story, update its body.
5. Run the **Entity Create And Edit** recipe to create or reuse ADRs with their decision text in the body. If you reuse an ADR, update its body.
6. Run the **Entity Create And Edit** recipe to create issues with their migrated implementation text in the body. If you reuse an issue, update its body.
7. Run the **Entity Relations** recipe to link issues to user stories with `fixes`.
8. Run the **Entity Relations** recipe to link ADR constraints with `constrains` when a decision clearly governs implementation work.
9. Run the **Entity Relations** recipe to link issue dependencies with `blocks`.

Publish blockers before you publish blocked issues, so every relation points to a real record.

When you migrate markdown docs, store the source text in the record body. Do not compress it into a title. Drop only the duplicate top-level heading when the record title already covers it. The **Entity Create And Edit** recipe uses direct MCP body input or its exact CLI standard-input fallback, so multiline markdown lands exactly as written.

### 4. Handle gaps and unclear cases carefully

- Do not create placeholder records for claims the source docs do not support.
- When the source material is old or contradictory, migrate only the parts you can defend. State the unresolved parts clearly.
- If a source task list is too coarse, break it into thin vertical slices before you create issues.
- If a doc appears to describe an existing record under a different title, reuse the existing record and report the mapping instead of creating a duplicate.

### 5. Return a migration report

Return a short report that includes:

- Each source document you processed.
- Every initiative, PRD, user story, ADR, and issue ID you created or reused.
- The links you added.
- Any source material you skipped, merged, or left unresolved.

Do not treat the migration as complete until the local `agent-issues` graph matches the source material.