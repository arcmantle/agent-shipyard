using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentLogbook.Core.Rpc;

/// <summary>An entity without its body, as <c>createEntity</c>, <c>listEntities</c> and the relation lists report it.</summary>
public sealed record EntitySummary(
	string Id,
	string Reference,
	string ShortReference,
	string CreatedBy,
	string UpdatedBy,
	string Kind,
	string Title,
	string Status,
	string? Category,
	string? Priority,
	string? Type,
	int Revision,
	string ContentHash,
	string CreatedAt,
	string UpdatedAt);

/// <summary>An entity with its body, as <c>getEntityDetails</c> reports its focus.</summary>
public sealed record EntityRecord(
	string Id,
	string Reference,
	string ShortReference,
	string CreatedBy,
	string UpdatedBy,
	string Kind,
	string Title,
	string Status,
	string Body,
	string BodySource,
	string? Category,
	string? Priority,
	string? Type,
	int Revision,
	string ContentHash,
	string CreatedAt,
	string UpdatedAt)
{
	public EntitySummary ToSummary() => new(
		Id, Reference, ShortReference, CreatedBy, UpdatedBy, Kind, Title, Status, Category, Priority, Type, Revision, ContentHash, CreatedAt, UpdatedAt);
}

/// <summary>A relation to or from the focus of <see cref="EntityDetails"/> and the entity at its other end.</summary>
public sealed record EntityRelationLink(string RelationType, EntitySummary Entity);

/// <summary>The observation of the workspace when an issue was completed.</summary>
public sealed record CompletionObservation(
	string Id,
	string IssueId,
	int CompletionOrdinal,
	string? RepositoryIdentity,
	string? CommitSha,
	string? Branch,
	bool? Dirty,
	string CapturedAt,
	string CalculatedVersionState,
	string? CalculatedVersion,
	IReadOnlyList<CompletionDiagnostic> Diagnostics);

public sealed record CompletionDiagnostic(string Code, string Message);

/// <summary>One page of the comments of an issue.</summary>
public sealed record IssueCommentPage(IReadOnlyList<JsonElement> Comments, IReadOnlyList<JsonElement> Users, int Total, string? NextBefore);

/// <summary>
/// The result of <see cref="EntityRpc.GetDetailsMethod"/>. <see cref="Comments"/> is only present for an issue. Plan entries and
/// version coverage are always empty in this release, because no feature that creates them is ported yet.
/// </summary>
public sealed record EntityDetails(
	EntityRecord Entity,
	IReadOnlyList<EntityRelationLink> Incoming,
	IReadOnlyList<EntityRelationLink> Outgoing,
	IReadOnlyList<JsonElement> PlanEntries,
	IReadOnlyList<CompletionObservation> CompletionObservations,
	CompletionObservation? CurrentCompletionObservation,
	IReadOnlyList<JsonElement> VersionCoverage)
{
	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public IssueCommentPage? Comments { get; init; }
}

/// <summary>A relation to create together with a new entity. Not available in this release.</summary>
public sealed record EntityLinkRequest(string RelationType, string TargetId);

/// <summary>The parameters of <see cref="EntityRpc.CreateMethod"/>. A field that is not set is left out of the request.</summary>
public sealed record CreateEntityRequest
{
	public string? Kind { get; init; }

	public string? Title { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public string? ParentId { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public string? Status { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public string? Body { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public string? Category { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public string? Priority { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public string? Type { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public IReadOnlyList<EntityLinkRequest>? Links { get; init; }
}

/// <summary>The parameters of <see cref="EntityRpc.GetDetailsMethod"/>.</summary>
public sealed record GetEntityDetailsRequest(string? EntityId);

/// <summary>The parameters of <see cref="EntityRpc.ListMethod"/>.</summary>
public sealed record ListEntitiesRequest(string? Kind);

/// <summary>The parameters of <see cref="EntityRpc.QueryMethod"/>. A field that is not set is left out of the request.</summary>
public sealed record QueryEntitiesRequest
{
	public string? Kind { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public IReadOnlyList<string>? Statuses { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public string? ParentId { get; init; }

	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public int? Limit { get; init; }
}

/// <summary>
/// The result of <see cref="EntityRpc.QueryMethod"/>. <see cref="Total"/> counts the entities that match before the limit.
/// <see cref="OpenBlockers"/> is only present for issues: it maps the reference of each returned issue to the references of its
/// open blocking issues.
/// </summary>
public sealed record QueryEntitiesResult(IReadOnlyList<EntitySummary> Entities, int Total)
{
	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public IReadOnlyDictionary<string, IReadOnlyList<string>>? OpenBlockers { get; init; }
}

/// <summary>The wire contract of the entity feature.</summary>
public static class EntityRpc
{
	public const string CreateMethod = "createEntity";
	public const string GetDetailsMethod = "getEntityDetails";
	public const string ListMethod = "listEntities";
	public const string QueryMethod = "queryEntities";
}
