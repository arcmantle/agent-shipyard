namespace AgentLogbook.Core.Entities;

/// <summary>An entity as the status derivation reads it: its ID, kind and stored status.</summary>
public readonly record struct StatusEntity(string Id, string Kind, string Status);

/// <summary>A relation as the status derivation reads it.</summary>
public readonly record struct StatusRelation(string FromId, string ToId, string Type);

/// <summary>
/// The derived status of entities. A stored status is the status that a person set; the status that readers see also follows the
/// graph: an issue with open sub-issues is blocked, a user story follows its fixing issues, a PRD follows its user stories, and an
/// initiative follows its tracked issues and owned PRDs. A record that a same-kind record supersedes reads as superseded.
/// </summary>
public static class EntityStatusDerivation
{
	/// <summary>The derived status of every entity, by ID. A relation to an entity that is not in <paramref name="entities"/> is ignored.</summary>
	public static Dictionary<string, string> Derive(IReadOnlyList<StatusEntity> entities, IReadOnlyList<StatusRelation> relations)
	{
		var byId = new Dictionary<string, StatusEntity>();
		foreach (var entity in entities)
		{
			byId[entity.Id] = entity;
		}

		var subIssuesByIssue = new Dictionary<string, List<string>>();
		var fixingIssuesByStory = new Dictionary<string, List<string>>();
		var storiesByPrd = new Dictionary<string, List<string>>();
		var trackedIssuesByInitiative = new Dictionary<string, List<string>>();
		var prdsByInitiative = new Dictionary<string, List<string>>();
		var supersededIds = new HashSet<string>();

		foreach (var relation in relations)
		{
			if (!byId.TryGetValue(relation.FromId, out var from) || !byId.TryGetValue(relation.ToId, out var to))
			{
				continue;
			}

			if (relation.Type == "decomposes" && from.Kind == "issue" && to.Kind == "issue")
			{
				Add(subIssuesByIssue, relation.FromId, relation.ToId);
			}
			else if (relation.Type == "fixes" && from.Kind == "issue" && to.Kind == "userStory")
			{
				Add(fixingIssuesByStory, relation.ToId, relation.FromId);
			}
			else if (relation.Type == "creates" && to.Kind == "userStory")
			{
				Add(storiesByPrd, relation.FromId, relation.ToId);
			}
			else if (relation.Type == "tracks" && to.Kind == "issue")
			{
				Add(trackedIssuesByInitiative, relation.FromId, relation.ToId);
			}
			else if (relation.Type == "owns" && to.Kind == "prd")
			{
				Add(prdsByInitiative, relation.FromId, relation.ToId);
			}
			else if (relation.Type == "supersedes" && from.Kind == to.Kind && from.Kind is "adr" or "prd" or "userStory")
			{
				supersededIds.Add(relation.ToId);
			}
		}

		var derived = new Dictionary<string, string>();
		var inProgress = new HashSet<string>();

		string StatusOf(string id)
		{
			if (derived.TryGetValue(id, out var cached))
			{
				return cached;
			}

			if (!byId.TryGetValue(id, out var entity))
			{
				return string.Empty;
			}

			// A cycle in the relations cannot be derived. It keeps the stored status instead of overflowing the stack.
			if (!inProgress.Add(id))
			{
				return entity.Status;
			}

			var statusesOf = (List<string>? ids) => (ids ?? []).Select(StatusOf).ToList();
			var issueTreeStatusesOf = (List<string>? ids) =>
			{
				var tree = new List<string>(ids ?? []);
				for (var index = 0; index < tree.Count; index++)
				{
					foreach (var child in subIssuesByIssue.GetValueOrDefault(tree[index]) ?? [])
					{
						if (!tree.Contains(child))
						{
							tree.Add(child);
						}
					}
				}

				return statusesOf(tree.Distinct().ToList());
			};

			var status = entity.Kind switch
			{
				"issue" => DeriveIssue(entity.Status, statusesOf(subIssuesByIssue.GetValueOrDefault(id))),
				"userStory" => DeriveUserStory(entity.Status, issueTreeStatusesOf(fixingIssuesByStory.GetValueOrDefault(id))),
				"prd" => DerivePrd(entity.Status, statusesOf(storiesByPrd.GetValueOrDefault(id))),
				"initiative" => DeriveInitiative(
					entity.Status,
					issueTreeStatusesOf(trackedIssuesByInitiative.GetValueOrDefault(id)),
					statusesOf(prdsByInitiative.GetValueOrDefault(id))),
				_ => entity.Status,
			};
			if (supersededIds.Contains(id))
			{
				status = "superseded";
			}

			inProgress.Remove(id);
			derived[id] = status;
			return status;
		}

		foreach (var entity in entities)
		{
			StatusOf(entity.Id);
		}

		return derived;
	}

	public static string DeriveIssue(string stored, IReadOnlyList<string> subIssueStatuses)
	{
		if (subIssueStatuses.Count == 0 || stored == "deferred")
		{
			return stored;
		}

		if (subIssueStatuses.Any(status => status is not "done" and not "deferred"))
		{
			return "blocked";
		}

		return stored == "blocked" ? "todo" : stored;
	}

	public static string DeriveUserStory(string stored, IReadOnlyList<string> fixingIssueStatuses)
	{
		if (fixingIssueStatuses.Count == 0)
		{
			return stored;
		}

		if (fixingIssueStatuses.All(status => status is "done" or "deferred"))
		{
			return "done";
		}

		return fixingIssueStatuses.Any(status => status is "in-progress" or "blocked" or "done") ? "in-progress" : "ready";
	}

	public static string DerivePrd(string stored, IReadOnlyList<string> createdStoryStatuses)
	{
		if (createdStoryStatuses.Count == 0)
		{
			return stored;
		}

		if (createdStoryStatuses.All(status => status is "done" or "superseded"))
		{
			return "approved";
		}

		return createdStoryStatuses.Any(status => status is "in-progress" or "done") ? "in-progress" : stored;
	}

	public static string DeriveInitiative(string stored, IReadOnlyList<string> trackedIssueStatuses, IReadOnlyList<string> ownedPrdStatuses)
	{
		if (trackedIssueStatuses.Count > 0
			&& trackedIssueStatuses.All(status => status is "done" or "deferred")
			&& ownedPrdStatuses.All(status => status is "approved" or "superseded"))
		{
			return "done";
		}

		var started = trackedIssueStatuses.Any(status => status is not "todo" and not "deferred")
			|| ownedPrdStatuses.Any(status => status != "draft");
		return stored == "draft" && started ? "active" : stored;
	}

	private static void Add(Dictionary<string, List<string>> map, string key, string value)
	{
		if (!map.TryGetValue(key, out var list))
		{
			map[key] = list = [];
		}

		list.Add(value);
	}
}
