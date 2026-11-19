namespace AgentLogbook.Core.RevisionLedger;

/// <summary>How a reverse patch stores the prior value of one field.</summary>
public enum ReversePatchFieldKind
{
	/// <summary>A string stored as a reverse text patch.</summary>
	Text,

	/// <summary>A JSON value stored as its compact JSON text.</summary>
	Value,
}

/// <summary>One field of a record kind. The numeric identifier is part of the stored patch format.</summary>
public sealed record ReversePatchField(int Id, string Key, ReversePatchFieldKind Kind);

/// <summary>The fields that the reverse patch of each record kind covers, in canonical order.</summary>
public static class ReversePatchRegistry
{
	private static readonly ReversePatchField[] Entity =
	[
		new(1, "title", ReversePatchFieldKind.Text),
		new(2, "body", ReversePatchFieldKind.Text),
		new(3, "bodySource", ReversePatchFieldKind.Value),
		new(4, "status", ReversePatchFieldKind.Value),
		new(5, "parentId", ReversePatchFieldKind.Value),
		new(6, "tombstone", ReversePatchFieldKind.Value),
		new(7, "category", ReversePatchFieldKind.Value),
		new(8, "priority", ReversePatchFieldKind.Value),
		new(9, "type", ReversePatchFieldKind.Value),
	];

	private static readonly ReversePatchField[] Context =
	[
		new(1, "title", ReversePatchFieldKind.Text),
		new(2, "summary", ReversePatchFieldKind.Text),
	];

	private static readonly ReversePatchField[] ContextTerm =
	[
		new(1, "definition", ReversePatchFieldKind.Text),
		new(2, "avoid", ReversePatchFieldKind.Value),
		new(3, "tombstone", ReversePatchFieldKind.Value),
		new(4, "term", ReversePatchFieldKind.Text),
	];

	private static readonly ReversePatchField[] IssueComment =
	[
		new(1, "body", ReversePatchFieldKind.Text),
		new(2, "referencedIssueIds", ReversePatchFieldKind.Value),
		new(3, "tombstone", ReversePatchFieldKind.Value),
	];

	private static readonly ReversePatchField[] PlanEntry =
	[
		new(1, "role", ReversePatchFieldKind.Value),
		new(2, "body", ReversePatchFieldKind.Text),
		new(3, "scopeDirection", ReversePatchFieldKind.Value),
		new(4, "referencedEntityIds", ReversePatchFieldKind.Value),
		new(5, "supersededEntryIds", ReversePatchFieldKind.Value),
		new(6, "tombstone", ReversePatchFieldKind.Value),
	];

	/// <summary>Returns the fields of one record kind.</summary>
	public static IReadOnlyList<ReversePatchField> For(RevisionPatchRecordKind kind) => kind switch
	{
		RevisionPatchRecordKind.Entity => Entity,
		RevisionPatchRecordKind.Context => Context,
		RevisionPatchRecordKind.ContextTerm => ContextTerm,
		RevisionPatchRecordKind.IssueComment => IssueComment,
		RevisionPatchRecordKind.PlanEntry => PlanEntry,
		_ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown revision patch record kind."),
	};
}
