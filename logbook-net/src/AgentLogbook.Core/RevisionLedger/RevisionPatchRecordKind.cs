namespace AgentLogbook.Core.RevisionLedger;

/// <summary>The record groups that the revision ledger addresses with a record key.</summary>
public enum RevisionPatchRecordKind
{
	Entity,
	Context,
	ContextTerm,
	IssueComment,
	PlanEntry,
}

/// <summary>Maps record kinds to the names that the stored ledger and the contract use.</summary>
public static class RevisionPatchRecordKinds
{
	public static string ToWireName(RevisionPatchRecordKind kind) => kind switch
	{
		RevisionPatchRecordKind.Entity => "entity",
		RevisionPatchRecordKind.Context => "context",
		RevisionPatchRecordKind.ContextTerm => "context-term",
		RevisionPatchRecordKind.IssueComment => "issue-comment",
		RevisionPatchRecordKind.PlanEntry => "plan-entry",
		_ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown revision patch record kind."),
	};

	public static RevisionPatchRecordKind FromWireName(string name) => name switch
	{
		"entity" => RevisionPatchRecordKind.Entity,
		"context" => RevisionPatchRecordKind.Context,
		"context-term" => RevisionPatchRecordKind.ContextTerm,
		"issue-comment" => RevisionPatchRecordKind.IssueComment,
		"plan-entry" => RevisionPatchRecordKind.PlanEntry,
		_ => throw new ArgumentException($"Unknown revision patch record kind '{name}'.", nameof(name)),
	};
}
