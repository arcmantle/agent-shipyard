# ADR Format

An ADR is an `adr` entity in `agent-issues`. It is not a file, unless the user asks for one directly.
Use the [ADR recipe](../recipes/adr.md) for its body.

## Template

Use the ADR title for the short decision name. Store the explanation in the entity body.

Suggested body shape:

```md
{1-3 sentences: what is the context, what did we decide, and why.}
```

This is enough. The value is in the record: a decision was made, and why.

## Optional sections

Add these sections only when they add real value:

- `Status` frontmatter (`current | superseded | archived`)
- `Considered Options`
- `Consequences`

## Identity

Let `agent-issues` assign the ADR ID. Do not create a separate numbering scheme outside the tracker.

## When to offer an ADR

All three of these must be true:

1. The decision is hard to reverse.
2. The decision is surprising without context.
3. The decision came from a real trade-off.

If a decision is easy to reverse, skip it. If it is not surprising, no one will ask why. If there was no real alternative, there is nothing useful to record.

### What qualifies

- Architecture shape.
- Integration patterns between contexts.
- Technology choices that create lock-in.
- Boundary and scope decisions.
- Deliberate moves away from the obvious path.
- Constraints not visible in the code.
- Rejected alternatives, when the rejection is not obvious.
