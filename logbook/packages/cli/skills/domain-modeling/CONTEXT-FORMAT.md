# Context Record Format

The canonical glossary lives in the `agent-issues` database. It does not live in a raw file.

Project context contains project-wide terms. Initiative context is the database equivalent of a `CONTEXT.md` file inside an initiative folder.
Use the [Context Summary recipe](../recipes/context-summary.md) for a context body and the [Context Term recipe](../recipes/context-term.md) for a term definition.

Run the **Context Read** recipe to read the relevant project or initiative glossary.

For project-wide discovery across shared and initiative scopes, run the **Context Read** recipe with search input.

Before you add or rename a term, run the **Context Read** recipe with conflict input to check whether the same label already exists in another scope.

Run the **Context Read** recipe with directory input only when you need the raw list of stored scopes.

Run the **Context Write** recipe to set up or update shared context with direct title and body text. Run it again to add or update a term with its definition and `avoid` terms as structured input.

## Structure

```json
{
	"context": {
		"key": "INIT1",
		"scopeKind": "initiative",
		"scopeEntityId": "INIT1",
		"scopeLabel": "Payments",
		"title": "Payments Context",
		"summary": "Glossary of initiative-specific terms for Payments.",
		"exists": true
	},
	"terms": [
		{
			"term": "Order",
			"definition": "A customer request accepted and tracked by the system.",
			"avoid": ["Purchase", "Transaction"]
		},
		{
			"term": "Invoice",
			"definition": "A request for payment sent to a customer after delivery.",
			"avoid": ["Bill", "Payment request"]
		}
	]
}
```

## Rules

- Be decisive. When more than one word exists for the same idea, pick the best one. List the others under `avoid`.
- Keep each definition short: one or two sentences. Define what the term is, not what it does.
- Include only terms specific to this project's context. Do not include general programming concepts.
- Group terms under subheadings when a natural cluster forms. If all terms belong to one area, a flat list is fine.
- Keep initiative context in the database. Do not copy it into a raw markdown file.

The `agent-issues` context model is initiative-scoped by default, with an optional shared default context. Read the relevant initiative context first. Use project-wide search only when you need to resolve which term is correct. Then update the scoped glossary, one term at a time, as the vocabulary becomes precise.
