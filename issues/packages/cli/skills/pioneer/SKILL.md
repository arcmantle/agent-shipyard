---
name: pioneer
description: Plan a huge chunk of work — more than one agent session can hold — as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.
disable-model-invocation: true
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Pioneering is about finding that way, not charging at the destination. This skill charts the way as a **shared map** in `agent-issues`, then works its **decision tickets** — questions whose resolution is a decision, not slices of a build to execute — one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Pioneer is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by title

Every map and ticket is an issue, so it has a **title**. In everything the human reads — narration and the map's Decisions-so-far — refer to it by title, not by an internal id, number, or slug. Include the complete `reference` returned by `agent-issues` in its link. Do not abbreviate or replace that reference.

## The Map

The map is a single `agent-issues` issue under the active initiative — the canonical artifact. Its tickets are child issues of the map.

Each pioneering effort requires one initiative-owned Plan. The Plan holds the detailed planning state; the map holds only its ticket frontier and concise links to ticket resolutions. Resolve an explicit Plan reference first. If it is unavailable in the current tracker scope, report that fact, then select an existing Plan under the active initiative or create one replacement Plan there. Record the selected Plan reference in the map Notes. Do not use an unavailable reference for Plan-entry operations or create a Plan per ticket.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.

Use `agent-issues` as the source of truth. Run the **Entity Create And Edit** recipe to create the map as a `pioneer-map` issue under the initiative and each ticket as a `pioneer-ticket` child of the map. Run the **Entity Relations** recipe to add dependencies after creation with `blocks` relations.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — run the **Entity List** recipe for child issues under the map when needed.
Use the [Pioneer Map recipe](../recipes/pioneer-map.md). It preserves the current map format.

### Tickets

Each ticket is a **child issue** of the map. Its body contains one question, sized to one 100K token agent session:
Use the [Pioneer Ticket recipe](../recipes/pioneer-ticket.md). It preserves the current ticket format.

The `## Ticket type` value is one of `research`, `prototype`, `grilling`, or `task`; see Ticket Types below.

A session **claims** a ticket before work by running the **Entity State And Structure** recipe to set its status to `in-progress`. If this fails because another session changed the ticket, reload the frontier and select another ticket. An open `todo` or `ready` ticket is unclaimed.

Blocking uses the native `blocks` relation. A ticket is **unblocked** when every blocker has status `done`; the **frontier** is the open, unblocked, unclaimed child issues. Run the **Entity List** recipe and use each child issue's `openBlockers` to identify it.

Run the **Entity Create And Edit** recipe to record the answer in `## Resolution` when the ticket is complete, then run the **Entity State And Structure** recipe to set the ticket status to `done`. Link assets created while resolving a ticket from the issue body; do not paste them into the map.

### Plan-backed ticket planning

For a grilling ticket, resume the map's Plan and give `plan` the complete ticket reference. Every Plan entry from that session uses the **Plan Entry Write** recipe to link back to the ticket reference.

The Plan is the canonical detailed resolution. When the ticket is done, retain its Question and status, and use a concise Resolution link to the Plan. Do not copy the detailed reasoning into the ticket. A Plan does not inform a Pioneer map.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked _with_ a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Read documentation, third-party APIs, or local resources to find a fact that a decision needs. Resolve it with a read-only research subagent. Use this type when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion with a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI or logic code through `prototype`. Link the prototype as an asset. Use this type when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation. This is the default type. Always use `plan` with `domain-modeling` active.
- **Task** (HITL or AFK): Manual work that must happen before a _decision_ can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that _does_ rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination — mis-scoped in while charting, or exposed by a resolution — **close it** (a closed ticket is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked — a scope boundary isn't a step on it.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.

### Chart the map

User invokes with a loose idea.

1. **Resolve the tracked scope and Plan.** Run the **Entity Read** recipe and the **Context Read** recipe to find the active initiative and read its context. For a new feature, run the **Entity Create And Edit** recipe to create a new initiative by default. Do not create a map outside an initiative. Resolve a supplied Plan reference, or select an existing Plan under that initiative. If the reference is unavailable or no Plan exists, report the unavailable reference when applicable and create one replacement initiative-owned Plan.
2. **Name the destination.** Run `plan` with `domain-modeling` active against the selected Plan to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so settle it first.
3. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surface the open decisions and the first steps that are possible now. **If this finds no fog** — the way to the destination is already clear and small enough for one session — do not create a map. Ask the user how to proceed.
4. **Create the map** as a `pioneer-map` child issue of the initiative: Destination and Notes filled in, Decisions-so-far empty, and the fog recorded in **Not yet specified**.
5. **Create the tickets you can specify now** as `pioneer-ticket` child issues of the map. Then wire `blocks` relations in a second pass, because issues need references before they can link to each other. This separates the frontier from blocked tickets. Keep everything you cannot yet specify in **Not yet specified**.
6. **Start research subagents.** For each new `research` ticket, start a read-only research subagent. It returns its findings to the current agent, which records the resolution and updates the ticket. Do not create a branch unless the research needs a prototype or another tracked artifact.
7. Stop — charting is one session's work; it does not resolve a HITL ticket.

### Work through the map

User invokes with a map (URL or number). A ticket is **optional** — without one, you pick the next decision, not the user.

1. Run the **Entity Read** recipe to load the **map**, then run the **Context Read** recipe for its scoped context. Do not load every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise select the first frontier ticket. **Claim it** by setting it to `in-progress` before work.
3. Resolve it — **zoom as needed**: run the **Entity Read** recipe or the **Relation Query** recipe to load related or closed tickets only when needed. Use the skills named in `## Notes`. For a grilling ticket, use `plan` with `domain-modeling` active and follow Plan-backed ticket planning.
4. Record the resolution: for a Plan-backed grilling ticket, retain its Ticket type and Question and use the **Entity Create And Edit** recipe to update only `## Resolution` with the concise Plan link. For other tickets, use that recipe to replace the ticket body with its completed `## Resolution`. Run the **Entity State And Structure** recipe to set the ticket status to `done`, and append a title-and-reference link with a one-line gist to the map's Decisions-so-far.
5. Add newly surfaced tickets with the **Entity Create And Edit** recipe, then link them with the **Entity Relations** recipe; graduate any fog that the answer made specific. Remove each graduated patch from **Not yet specified** so it exists only in its new ticket. If the answer shows that a ticket sits beyond the destination, **rule it out of scope** instead of resolving it on the route. If the decision invalidates other map parts, update or delete those tickets. When no open tickets or in-scope fog remain, run the **Entity State And Structure** recipe to set the map status to `done`.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently.

## Next-session prompt

Every session-ending question MUST end with the exact prompt the user can copy and paste into a new session without edits. Put the complete prompt in a fenced `text` block as the final content of the response. Do not put another question or explanation after it.

Start the prompt with the skill invocation for the next action, such as `/agent-issues pioneer`, `/agent-issues plan`, or `/agent-issues prototype`. Select the skill yourself from the ticket type and its Notes; do not ask the user to select a skill or assemble the prompt. Use `/agent-issues pioneer` to continue the map and select the next ticket. For an unfinished ticket, name the skill needed to resume its current work and include the ticket reference, map reference, and selected Plan reference. For `/agent-issues plan`, also specify that `domain-modeling` must be active.

Use actual titles and complete tracker references. Replace every placeholder before you show the prompt. Include all context needed to resume from the tracker without the previous conversation. Keep the prompt short; do not repeat the skill's workflow instructions. Do not claim the next ticket in the current session. If no ticket is available, use `/agent-issues pioneer` to review **Not yet specified** and the blockers with the user.

After charting a map or completing a ticket, use this form with every placeholder replaced:

```text
/agent-issues pioneer Continue the map "<map title>" (<complete map reference>) with Plan <complete Plan reference>.
```

If the map is complete, or no map was created, ask the user which next action to take and provide the exact skill invocation and prompt for that action. Do not invent tracker references or present a completed map as unfinished.