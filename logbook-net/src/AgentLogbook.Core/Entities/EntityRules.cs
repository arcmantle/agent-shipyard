using AgentLogbook.Core.WorkflowSchema;

namespace AgentLogbook.Core.Entities;

/// <summary>
/// The workflow rules of entity records: kinds, status flows, allowed relations, categories, priorities and types. They read the
/// embedded workflow schema, so <c>schema</c>, the CLI and the storage layer agree on one source.
/// </summary>
public static class EntityRules
{
	/// <summary>The entity types that each kind accepts. Only issues have types.</summary>
	private static readonly Dictionary<string, string[]> TypesByKind = new Dictionary<string, string[]>
	{
		["issue"] = ["pioneer-map", "pioneer-ticket"],
	};

	private static readonly Dictionary<string, EntityKindSchema> Kinds =
		WorkflowSchema.WorkflowSchema.Current.EntityKinds.ToDictionary(kind => kind.Kind, StringComparer.Ordinal);

	private static readonly HashSet<string> StructuralTypes = [.. WorkflowSchema.WorkflowSchema.Current.StructuralRelationTypes];

	public static bool IsKind(string? value) => value is not null && Kinds.ContainsKey(value);

	public static string InitialStatus(string kind) => Kinds[kind].InitialStatus;

	public static bool IsValidStatus(string kind, string status) => Kinds[kind].Statuses.Contains(status);

	public static bool IsCategory(string value) => WorkflowSchema.WorkflowSchema.Current.EntityCategories.Contains(value);

	public static bool IsPriority(string value) => WorkflowSchema.WorkflowSchema.Current.EntityPriorities.Contains(value);

	public static bool IsType(string kind, string value) => TypesByKind.TryGetValue(kind, out var types) && types.Contains(value);

	/// <summary>The relation that makes <paramref name="fromKind"/> the parent of <paramref name="toKind"/>: the first allowed relation of that pair, or null.</summary>
	public static string? AllowedRelationType(string fromKind, string toKind) =>
		WorkflowSchema.WorkflowSchema.Current.AllowedRelations
			.FirstOrDefault(relation => relation.FromKind == fromKind && relation.ToKind == toKind)?.Type;

	public static bool IsStructuralRelationType(string relationType) => StructuralTypes.Contains(relationType);

	/// <summary>The structural relation types, in schema order.</summary>
	public static IReadOnlyList<string> StructuralRelationTypes { get; } = WorkflowSchema.WorkflowSchema.Current.StructuralRelationTypes;
}
