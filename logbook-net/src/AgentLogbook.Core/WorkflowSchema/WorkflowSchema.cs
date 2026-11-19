using System.Text.Json;

namespace AgentLogbook.Core.WorkflowSchema;

/// <summary>One entity kind with its id prefix and status flow.</summary>
public sealed record EntityKindSchema(
	string Kind,
	string IdPrefix,
	string InitialStatus,
	IReadOnlyList<string> Statuses,
	string ArchiveStatus);

/// <summary>One allowed relation between two entity kinds.</summary>
public sealed record AllowedRelation(string FromKind, string ToKind, string Type);

/// <summary>A structural relation that makes one kind the parent of another.</summary>
public sealed record ParentRule(string ParentKind, string ChildKind, string RelationType);

/// <summary>The shared context storage and its commands.</summary>
public sealed record ContextSchema(
	string Storage,
	IReadOnlyList<string> Scopes,
	string DefaultKey,
	string ListCommand,
	string ReadCommand,
	string SearchCommand,
	string ConflictsCommand,
	string InitializeCommand,
	string DefineCommand,
	string ForgetCommand,
	IReadOnlyList<string> TermFields);

/// <summary>The issue comment records and their commands.</summary>
public sealed record IssueCommentSchema(
	string Storage,
	string ParentKind,
	string RecordPrefix,
	string AddCommand,
	string ListCommand,
	string EditCommand,
	string DeleteCommand,
	string HistoryCommand,
	IReadOnlyList<string> Fields);

/// <summary>The Plan entry records and their commands.</summary>
public sealed record PlanEntrySchema(
	string Storage,
	string ParentKind,
	string RecordPrefix,
	string LinkRelationType,
	string LinkTargetKind,
	string AddCommand,
	string LinkCommand,
	string UnlinkCommand,
	IReadOnlyList<string> Fields);

/// <summary>
/// The workflow schema that <c>schema</c> and <c>capabilities</c> serve. The member order is the JSON key order.
/// The data comes from the embedded <c>workflow-schema.json</c>, an export of the recorded TypeScript result.
/// </summary>
public sealed record WorkflowSchema(
	IReadOnlyList<EntityKindSchema> EntityKinds,
	IReadOnlyList<string> EntityCategories,
	IReadOnlyList<string> EntityPriorities,
	IReadOnlyList<string> RelationTypes,
	IReadOnlyList<AllowedRelation> AllowedRelations,
	IReadOnlyList<string> StructuralRelationTypes,
	IReadOnlyList<ParentRule> ParentRules,
	ContextSchema Context,
	IssueCommentSchema IssueComments,
	PlanEntrySchema PlanEntries)
{
	private const string ResourceName = "AgentLogbook.Core.WorkflowSchema.workflow-schema.json";

	private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

	/// <summary>The schema that this release serves.</summary>
	public static WorkflowSchema Current { get; } = Load();

	private static WorkflowSchema Load()
	{
		using var stream = typeof(WorkflowSchema).Assembly.GetManifestResourceStream(ResourceName)
			?? throw new InvalidOperationException($"The embedded resource {ResourceName} is missing.");
		return JsonSerializer.Deserialize<WorkflowSchema>(stream, ReadOptions)
			?? throw new InvalidOperationException("The embedded workflow schema is empty.");
	}
}
