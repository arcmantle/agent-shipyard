---
name: recipe-migration
description: Restructure approved tracker record bodies to use their applicable record body recipes.
disable-model-invocation: true
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Recipe Migration

Recipe migration is a user-invoked process that restructures existing authored bodies to use their applicable [record body recipes](../recipes/README.md). It preserves the source meaning, keeps typed facts and graph relations outside body prose, and writes through normal tracker revisions.

## Scope

Start from an entity, initiative, shared context, or full project. Preview one selected scope at a time:

- **Entity:** Run the **Entity Read** recipe.
- **Initiative:** Run the **Initiative Read** recipe and the **Context Read** recipe.
- **Shared context:** Run the **Context Read** recipe for the shared context.
- **Full project:** Run the **Entity List** recipe for each supported entity kind, then run the **Context Read** recipe with directory input.

Include authored entity bodies, context summaries, and context terms in the selected scope. Do not migrate generated bodies, empty bodies, or issue comments. Comment migration remains reserved until comment records exist.

## Preview

1. Read the applicable recipe for every selected record.
2. Produce a per-record migration preview before any write. Include the complete tracker reference, record kind, observed revision, and the proposed body.
3. Preserve clear source content. Put content that cannot be assigned safely in `## Notes` when that recipe has a Notes section.
4. Do not add status, parentage, timestamps, revisions, references, or graph relations to body prose. Do not use the generated-content marker as an authored placeholder.
5. Show unchanged records and per-record exclusions with the proposed changes. Let the user exclude any record.

For a full-project recipe migration, preview all supported authored entity bodies and all context summaries and term definitions in the current project. Do not write while the preview is under review.

## Approval And Write

1. Ask for explicit approval of the remaining preview. Approval may cover the selected scope after per-record exclusions.
2. Before each write, run the **Entity Read** recipe or the **Context Read** recipe to reload the record and compare its revision and body with the preview. The migration skips it when the body changed after preview. Do not retry or overwrite a stale record.
3. Run the **Entity Create And Edit** recipe to update an approved entity with direct body text.
4. Run the **Context Write** recipe to update an approved context summary with direct title and body text.
5. Run the **Context Write** recipe to update an approved context term with direct definition and `avoid` text.

Use existing tracker operations only. Do not add a recipe operation group or conditional-write options.

## Report

Report updated, unchanged, excluded, and stale records separately. For every item, include its complete tracker reference. For updated records, report the prior and resulting revisions. Run the **Revision Read** recipe before the **Entity Restore** recipe or the **Context Restore** recipe. The context restore recipe explicitly identifies its CLI-only fallback.

End after the report. A stale record needs a new preview before it can be considered again.