using AgentLogbook.Core.Entities;
using AgentLogbook.Core.Identity;
using AgentLogbook.Core.Rpc;

namespace AgentLogbook.Storage.Postgres.Entities;

/// <summary>The columns of an entity that every read selects, without the body. Dapper fills it by column name.</summary>
internal class SummaryRow
{
	/// <summary>The author that a row without a stored author reports, as the TypeScript implementation does.</summary>
	private const string SystemAuthor = "system";

	public string Id { get; init; } = "";

	public string Reference { get; init; } = "";

	public string? ShortReference { get; init; }

	public string? CreatedBy { get; init; }

	public string? UpdatedBy { get; init; }

	public string Kind { get; init; } = "";

	public string Title { get; init; } = "";

	public string Status { get; init; } = "";

	public string? Category { get; init; }

	public string? Priority { get; init; }

	public string? Type { get; init; }

	public int? Revision { get; init; }

	public string? ContentHash { get; init; }

	public string? ProjectId { get; init; }

	public string CreatedAt { get; init; } = "";

	public string UpdatedAt { get; init; } = "";

	public EntitySummary ToSummary(string? status = null)
	{
		RequireKnownKind();
		return new EntitySummary(
			Id,
			Reference,
			ShortReference ?? CanonicalReference.ShortReference(Id, Kind),
			CreatedBy ?? SystemAuthor,
			UpdatedBy ?? SystemAuthor,
			Kind,
			Title,
			status ?? Status,
			KnownCategory(),
			KnownPriority(),
			KnownType(),
			Revision ?? 1,
			ContentHash ?? "",
			CreatedAt,
			UpdatedAt);
	}

	// The stored value only counts when it is a value of the workflow. Anything else reads as not set.
	protected string? KnownCategory() => !string.IsNullOrEmpty(Category) && EntityRules.IsCategory(Category) ? Category : null;

	protected string? KnownPriority() => !string.IsNullOrEmpty(Priority) && EntityRules.IsPriority(Priority) ? Priority : null;

	protected string? KnownType() => !string.IsNullOrEmpty(Type) && EntityRules.IsType(Kind, Type) ? Type : null;

	protected void RequireKnownKind()
	{
		if (!EntityRules.IsKind(Kind))
		{
			throw new InvalidOperationException($"Unexpected entity kind in database: {Kind}");
		}
	}
}

/// <summary>An entity row with its body.</summary>
internal sealed class EntityRow : SummaryRow
{
	public string? Body { get; init; }

	public string? BodySource { get; init; }

	public EntityRecord ToRecord(string? status = null)
	{
		var summary = ToSummary(status);
		return new EntityRecord(
			summary.Id,
			summary.Reference,
			summary.ShortReference,
			summary.CreatedBy,
			summary.UpdatedBy,
			summary.Kind,
			summary.Title,
			summary.Status,
			Body ?? "",
			BodySource is "authored" or "generated" ? BodySource : "authored",
			summary.Category,
			summary.Priority,
			summary.Type,
			summary.Revision,
			summary.ContentHash,
			summary.CreatedAt,
			summary.UpdatedAt);
	}
}

/// <summary>A summary row with the type of the relation that reaches it.</summary>
internal sealed class LinkRow : SummaryRow
{
	public string RelationType { get; init; } = "";
}

internal sealed record RelationRow(string FromId, string ToId, string Type);
