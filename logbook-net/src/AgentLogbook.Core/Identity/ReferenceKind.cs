namespace AgentLogbook.Core.Identity;

/// <summary>The record kinds that have a canonical reference. The first eleven are the entity kinds.</summary>
public enum ReferenceKind
{
	Project,
	Epic,
	Version,
	Initiative,
	Prd,
	UserStory,
	Adr,
	Issue,
	Debt,
	Handoff,
	Plan,
	PlanEntry,
	Context,
	ContextTerm,
	IssueComment,
}

/// <summary>Maps reference kinds to the wire names and reference prefixes of the retained contract.</summary>
public static class ReferenceKinds
{
	/// <summary>
	/// The order in which a decoder tries prefixes. <c>PLAN_ENTRY</c> comes before <c>PLAN</c> because
	/// the first prefix that starts the reference wins.
	/// </summary>
	internal static readonly ReferenceKind[] DecodeOrder =
	[
		ReferenceKind.PlanEntry,
		ReferenceKind.Project,
		ReferenceKind.Epic,
		ReferenceKind.Version,
		ReferenceKind.Initiative,
		ReferenceKind.Prd,
		ReferenceKind.UserStory,
		ReferenceKind.Adr,
		ReferenceKind.Issue,
		ReferenceKind.Debt,
		ReferenceKind.Handoff,
		ReferenceKind.Plan,
		ReferenceKind.Context,
		ReferenceKind.ContextTerm,
		ReferenceKind.IssueComment,
	];

	/// <summary>Whether the kind is one of the eleven entity kinds.</summary>
	public static bool IsEntityKind(ReferenceKind kind) => kind is >= ReferenceKind.Project and <= ReferenceKind.Plan;

	/// <summary>The camelCase name of the kind in the stored data and in derivation input.</summary>
	public static string ToWireName(ReferenceKind kind) => kind switch
	{
		ReferenceKind.Project => "project",
		ReferenceKind.Epic => "epic",
		ReferenceKind.Version => "version",
		ReferenceKind.Initiative => "initiative",
		ReferenceKind.Prd => "prd",
		ReferenceKind.UserStory => "userStory",
		ReferenceKind.Adr => "adr",
		ReferenceKind.Issue => "issue",
		ReferenceKind.Debt => "debt",
		ReferenceKind.Handoff => "handoff",
		ReferenceKind.Plan => "plan",
		ReferenceKind.PlanEntry => "planEntry",
		ReferenceKind.Context => "context",
		ReferenceKind.ContextTerm => "contextTerm",
		ReferenceKind.IssueComment => "issueComment",
		_ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown reference kind."),
	};

	/// <summary>The kind for a wire name, or null when the name is not a reference kind.</summary>
	public static ReferenceKind? FromWireName(string name)
	{
		ArgumentNullException.ThrowIfNull(name);
		foreach (var kind in DecodeOrder)
		{
			if (ToWireName(kind) == name)
			{
				return kind;
			}
		}

		return null;
	}

	/// <summary>The reference prefix of the kind, for example <c>ISS</c>.</summary>
	public static string ToPrefix(ReferenceKind kind) => kind switch
	{
		ReferenceKind.Project => "PROJ",
		ReferenceKind.Epic => "EPIC",
		ReferenceKind.Version => "VER",
		ReferenceKind.Initiative => "INIT",
		ReferenceKind.Prd => "PRD",
		ReferenceKind.UserStory => "US",
		ReferenceKind.Adr => "ADR",
		ReferenceKind.Issue => "ISS",
		ReferenceKind.Debt => "DEBT",
		ReferenceKind.Handoff => "HO",
		ReferenceKind.Plan => "PLAN",
		ReferenceKind.PlanEntry => "PLAN_ENTRY",
		ReferenceKind.Context => "CTX",
		ReferenceKind.ContextTerm => "TERM",
		ReferenceKind.IssueComment => "COM",
		_ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown reference kind."),
	};
}
