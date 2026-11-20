using System.Text;
using AgentLogbook.Core.Rpc;

namespace AgentLogbook.Cli.Entities;

/// <summary>An entity as the JSON of <c>list</c> and the creation acknowledgement print it.</summary>
internal sealed record CompactEntity(string Id, string Reference, string Kind, string Status, string Title)
{
	public static CompactEntity From(EntitySummary entity) => new(entity.Id, entity.Reference, entity.Kind, entity.Status, entity.Title);
}

internal sealed record CreateAcknowledgement(string Operation, string Id, string Reference, string Status, int Revision);

internal sealed record CompactEntityList(IReadOnlyList<CompactEntity> Items, int Total)
{
	public IReadOnlyDictionary<string, IReadOnlyList<string>>? OpenBlockers { get; init; }
}

/// <summary>The human text and the compact JSON of the entity commands. They print what the TypeScript commands print.</summary>
internal static class EntityOutput
{
	public static CompactEntityList ToCompactList(QueryEntitiesResult result) =>
		new(result.Entities.Select(CompactEntity.From).ToList(), result.Total) { OpenBlockers = result.OpenBlockers };

	/// <summary>One line for each entity, or <c>No &lt;kind&gt; entities found.</c>. An issue line ends with its open blockers.</summary>
	public static string RenderList(string kind, QueryEntitiesResult result)
	{
		var entities = result.Entities;
		var openBlockers = result.OpenBlockers;
		if (entities.Count == 0)
		{
			return $"No {kind} entities found.";
		}

		return string.Join("\n", entities.Select(entity =>
		{
			var blockers = openBlockers is not null && openBlockers.TryGetValue(entity.Reference, out var list) ? list : [];
			var suffix = blockers.Count > 0 ? $" (blocked by {string.Join(", ", blockers)})" : string.Empty;
			return $"{entity.Reference} {entity.Status} {entity.Title}{suffix}";
		}));
	}

	public static string RenderDetails(EntityDetails details)
	{
		var entity = details.Entity;
		var incoming = details.Incoming.Count > 0
			? string.Join("\n", details.Incoming.Select(link => $"{link.Entity.Reference} {link.Entity.Kind} --{link.RelationType}--> {entity.Reference}"))
			: "none";
		var outgoing = details.Outgoing.Count > 0
			? string.Join("\n", details.Outgoing.Select(link => $"{entity.Reference} --{link.RelationType}--> {link.Entity.Reference} {link.Entity.Kind}"))
			: "none";
		var type = entity.Type is null ? string.Empty : $" {entity.Type}";
		return new StringBuilder()
			.Append(entity.Reference).Append(' ').Append(entity.Kind).Append(type).Append(' ').Append(entity.Status).Append(' ').Append(entity.Title).Append('\n')
			.Append("Incoming:\n").Append(incoming).Append('\n')
			.Append("Outgoing:\n").Append(outgoing).Append('\n')
			.Append("Related Plan entries:\nnone")
			.ToString();
	}
}
