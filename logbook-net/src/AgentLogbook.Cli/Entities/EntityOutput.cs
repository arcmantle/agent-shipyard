using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
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

	public static string RenderBundle(InitiativeBundle bundle)
	{
		static string Compact(IReadOnlyList<EntityRecord> entities) =>
			entities.Count == 0 ? "none" : string.Join(", ", entities.Select(entity => $"{entity.Reference}:{entity.Status}"));

		static string Links<T>(IReadOnlyList<T> links, Func<T, string> render) => links.Count == 0 ? "none" : string.Join(", ", links.Select(render));

		return string.Join("\n",
			$"{bundle.Initiative.Reference} {bundle.Initiative.Status} {bundle.Initiative.Title}",
			$"PRDs: {Compact(bundle.Prds)}",
			$"User Stories: {Compact(bundle.UserStories)}",
			$"ADRs: {Compact(bundle.Adrs)}",
			$"Issues: {Compact(bundle.Issues)}",
			$"Fixes: {Links(bundle.FixLinks, link => $"{link.Issue.Reference} -> {link.UserStory.Reference}")}",
			$"Sub-issues: {Links(bundle.SubIssueLinks, link => $"{link.Parent.Reference} -> {link.Issue.Reference}")}",
			$"Blockers: {Links(bundle.BlockerLinks, link => $"{link.Source.Reference} -> {link.Target.Reference}")}",
			$"Constrains: {Links(bundle.ConstrainsLinks, link => $"{link.Adr.Reference} -> {link.Issue.Reference}")}");
	}

	/// <summary>The groups of the current Plan, in the order of the TypeScript Plan projection.</summary>
	private static readonly (string Key, string Title)[] PlanGroups =
	[
		("questions", "Questions"),
		("decisions", "Decisions"),
		("includedScope", "Included scope"),
		("excludedScope", "Excluded scope"),
		("constraints", "Constraints"),
		("preferences", "Preferences"),
		("considerations", "Considerations"),
	];

	/// <summary>
	/// The details of a Plan with its projection. No ported feature creates Plan entries, so every group is empty and the history is empty.
	/// </summary>
	public static JsonObject PlanDetails(EntityDetails details)
	{
		var result = (JsonObject)JsonSerializer.SerializeToNode(details, RpcWire.JsonOptions)!;
		result["current"] = new JsonArray([.. PlanGroups.Select(group => (JsonNode)new JsonObject
		{
			["key"] = group.Key,
			["title"] = group.Title,
			["entries"] = new JsonArray(),
		})]);
		result["history"] = new JsonArray();
		return result;
	}

	public static string RenderPlanDetails(EntityDetails details) => string.Join("\n",
		RenderDetails(details),
		"Current Plan:",
		string.Join("\n", PlanGroups.Select(group => $"{group.Title}: none")),
		"History:",
		"none");
}
