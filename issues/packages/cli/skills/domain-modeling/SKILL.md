---
name: domain-modeling
description: Builds and sharpens the tracked domain model. It resolves terms, tests boundaries with real scenarios, checks the model against the code, and records glossary terms and architecture decisions. Use it when the user wants to define domain language, refine a model, record an ADR, or when another skill needs active domain modeling.
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Domain Modeling

Actively build and sharpen the project's domain model while you design. This skill changes the model. It challenges terms, tests edge cases, and records resolved language and decisions. If you only read initiative context for known vocabulary, you do not need this skill.

## During the session

### Challenge against the glossary

The user can use a term that conflicts with the relevant glossary or the **Context Read** recipe with conflict input. When this happens, point it out right away.

### Sharpen fuzzy language

The user can use a vague or overloaded term. When this happens, propose one precise term.

### Discuss concrete scenarios

When you discuss domain relationships, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force precision about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a conflict, point it out.

### Maintain the context summary

At the start of initiative planning, create the initiative context summary when it does not exist. Update it when planning settles a durable purpose, boundary, or working agreement. Do not use the summary as a plan or implementation log.

When the Plan or Grill skill runs the architecture-capture gate, use its classification list as input. Write the requested context summary, terms, and ADRs. Report the records written back to the calling skill. The calling skill resolves uncertain classifications and determines when the gate is complete.

### Update context inline

When you resolve a term, run the **Context Write** recipe to update the database-backed context right away. Do not batch glossary updates. Use the rules in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

### Capture ADRs when needed

During the architecture-capture gate, classify each settled decision. Create an ADR when all three of these are true:

1. The decision is hard to reverse.
2. The decision is surprising without context.
3. The decision came from a real trade-off.

If any of the three is not true, keep it as a Plan decision. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

When an ADR is needed, run the **Entity Create And Edit** recipe to create or update the `adr` entity under the relevant initiative. Do not create a markdown ADR file unless the user asks for one directly. If the ADR limits implementation work, run the **Entity Relations** recipe to link it to the affected issues with `constrains`.
