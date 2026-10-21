---
name: plan
description: Ask the user detailed questions about a plan, decision, or idea. Use when the user wants to test a plan or uses a plan trigger phrase.
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

Use the `domain-modeling` skill for this interview.

## Persist Plan State

At the start of a new planning effort, run the **Entity Read** recipe for the active initiative. A Plan is required. If the user gives an explicit Plan reference, resolve it first. Resume it when it is a Plan owned by the active initiative. If it is unavailable in the current tracker scope, state that fact and create one replacement initiative-owned Plan with a stable Goal and Context body. Otherwise, create one initiative-owned Plan. Do not use an unavailable reference for Plan-entry operations or create a duplicate Plan.

Use the **Plan Entry Write** recipe to record planning state as it changes:

- Record each design question as a `question` entry before asking it.
- Record each durable user answer before continuing to the next round. When an answer resolves a design question, add a `decision` entry that supersedes the question reference.
- Record each durable fact from code or tool output before it affects later planning. Use the approved role that describes the fact.
- Replace a changed entry by superseding it. A decision targets a question or decision. Edit only corrections.
- Add no entry for transient conversation that does not change planning state.

Before you ask the user to confirm shared understanding, the Plan skill must coordinate the **architecture-capture gate**. Review every active Plan decision, constraint, and durable fact. The Plan skill owns classification and keeps the final classification list. `domain-modeling` owns the context-summary, term, and ADR writes. Complete the gate in this order:

- Classify each active Plan decision, constraint, and durable fact as context, ADR, or Plan-only.
- Classify an item as Plan-only when it is reversible and limited to the current Plan or implementation slice. When a classification is uncertain, resolve it before readiness.
- Direct `domain-modeling` to create or update the initiative context summary with the durable purpose, boundaries, and working agreements that planning established.
- Define or update an initiative context term for stable domain language, non-obvious system facts, and shared integration contracts that will recur outside this Plan.
- Create an initiative-owned ADR for each settled decision that is hard to reverse, surprising without context, and based on a real trade-off. Do not defer qualifying ADRs to `to-prd` or `to-issues`.
- Keep pilot sequencing, temporary scope, and local implementation details as Plan entries only.

The gate is complete only after `domain-modeling` reports the context and ADR records it wrote, and the Plan skill reports the classification list to the user as the shared-understanding summary. First confirm that the planning frontier is empty. Then complete and report the gate. Then ask the user to confirm shared understanding. Only after confirmation, run the **Entity State And Structure** recipe to set the Plan to `ready`. A ready Plan can retain only explicit implementation-discovery questions.

Ask questions until you and the user have the same understanding. Make a **design tree**. Each decision has related decisions below it.

Work on the tree in **rounds**. The **frontier** contains all decisions with settled prerequisites. These are the questions that you can ask now. Do not assume an answer that the user has not given. Ask all frontier questions in one round. Number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body. It can have more than one paragraph or choice.>

➡️ <your recommended answer>
```

After each user response, update the tree. A settled decision can make more questions ready. Calculate the frontier again, then ask the next round. Put a question in a later round if its answer needs an answer from an open question in the current round.

Find _facts_ yourself. Do not ask the user for facts that you can find in the environment, such as files or tool output. When a frontier question needs a fact, send a sub-agent to find it. Do not wait for the sub-agent. Treat the fact search as an unsettled prerequisite. Wait for its result before you ask questions that need that fact. Ask other frontier questions now. The user makes the _decisions_. Ask the user for each decision and wait for an answer.

End the session when the frontier is empty and the architecture-capture gate is complete. At this point, you have checked each branch of the design tree. Do not leave any assumption unstated. Do not act until the user confirms that you and the user have the same understanding.