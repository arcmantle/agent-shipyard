using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AgentLogbook.Core.ContentHashes;
using AgentLogbook.Core.Entities;
using AgentLogbook.Core.Identity;
using AgentLogbook.Core.RevisionLedger;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Core.Workspaces;
using AgentLogbook.Storage.Postgres.Workspaces;
using Dapper;
using Npgsql;

namespace AgentLogbook.Storage.Postgres.Entities;

/// <summary>
/// The entity operations inside one open tenant transaction, for one resolved project. The SQL is the SQL of the TypeScript
/// Postgres storage, one statement for one statement.
/// </summary>
internal sealed partial class EntitySession(
	NpgsqlConnection connection,
	NpgsqlTransaction transaction,
	string tenantId,
	string projectId,
	string? projectIdentity,
	TenantWorkspace workspace,
	CancellationToken cancellationToken)
{
	/// <summary>The columns of <see cref="SummaryRow"/>. The same text builds every entity read.</summary>
	private const string SummaryColumns =
		"entities.id::text AS Id, entities.reference AS Reference, entities.short_reference AS ShortReference, entities.created_by::text AS CreatedBy, " +
		"entities.updated_by::text AS UpdatedBy, entities.kind AS Kind, entities.title AS Title, entities.status AS Status, entities.category AS Category, " +
		"entities.priority AS Priority, entities.type AS Type, entities.revision AS Revision, entities.content_hash AS ContentHash, " +
		"entities.project_id::text AS ProjectId, entities.created_at AS CreatedAt, entities.updated_at AS UpdatedAt";

	private const string EntityColumns = SummaryColumns + ", entities.body AS Body, entities.body_source AS BodySource";

	private static readonly JsonSerializerOptions DiagnosticOptions = new(JsonSerializerDefaults.Web);

	private readonly string? selector = string.IsNullOrWhiteSpace(projectIdentity) ? null : projectIdentity.Trim();

	// ---- create ----

	public async Task<EntitySummary> CreateAsync(string actorSubject, CreateEntityRequest request)
	{
		var actorId = await UpsertUserAsync(actorSubject);

		// A project identity that names one record directly (an ID or a reference) pins the parent to that project.
		if (selector is not null && CanonicalReference.IsDirectEntitySelector(selector)
			&& !string.IsNullOrEmpty(request.ParentId) && !await ProjectEntityExistsAsync(request.ParentId, includeTombstone: false))
		{
			throw new EntityException($"Entity not found: {request.ParentId}");
		}

		if (!EntityRules.IsKind(request.Kind))
		{
			throw new EntityException($"Unknown entity kind: {request.Kind ?? "undefined"}");
		}

		var kind = request.Kind!;
		var title = JavaScriptWhiteSpace.Trim(request.Title ?? string.Empty);
		if (title.Length == 0)
		{
			throw new EntityException("Entity title must not be empty.");
		}

		var body = request.Body ?? string.Empty;
		var requestedStatus = request.Status ?? EntityRules.InitialStatus(kind);
		var status = kind == "plan" ? EntityRules.InitialStatus(kind) : requestedStatus;
		if (!EntityRules.IsValidStatus(kind, requestedStatus))
		{
			throw new EntityException($"Invalid status for {kind}: {requestedStatus}");
		}

		if (request.Category is { } category && !EntityRules.IsCategory(category))
		{
			throw new EntityException($"Invalid entity category: {category}");
		}

		if (request.Priority is { } priority && !EntityRules.IsPriority(priority))
		{
			throw new EntityException($"Invalid entity priority: {priority}");
		}

		if (request.Type is { } entityType && !EntityRules.IsType(kind, entityType))
		{
			throw new EntityException($"Invalid entity type: {entityType}");
		}

		if (kind == "debt" && (request.Category is null || request.Priority is null))
		{
			throw new EntityException("Debt requires category and priority.");
		}

		if (request.Links is { Count: > 0 })
		{
			throw new EntityException("Relations cannot be created together with an entity in this release.");
		}

		var now = TenantWorkspace.Now();
		var parentId = request.ParentId ?? (kind == "initiative" ? await ResolveDefaultEpicIdAsync() : null);
		var parent = string.IsNullOrEmpty(parentId) ? null : await GetEntityOrThrowAsync(parentId);
		var relationType = parent is null ? null : EntityRules.AllowedRelationType(parent.Kind, kind);
		if (kind == "debt" && parent is null)
		{
			throw new EntityException("Debt requires a project, epic, initiative, or issue owner.");
		}

		if (kind == "plan" && parent?.Kind != "initiative")
		{
			throw new EntityException("Plan requires an initiative parent.");
		}

		if (parent is not null && relationType is null)
		{
			throw new EntityException($"Cannot create {kind} under {parent.Kind}.");
		}

		if (request.Type == "pioneer-map" && parent?.Kind != "initiative")
		{
			throw new EntityException("pioneer-map requires an initiative parent.");
		}

		if (request.Type == "pioneer-ticket" && (parent?.Kind != "issue" || parent.Type != "pioneer-map"))
		{
			throw new EntityException("pioneer-ticket requires a pioneer-map parent.");
		}

		var stableId = Guid.NewGuid().ToString("D");
		var reference = CanonicalReference.Encode(ReferenceKinds.FromWireName(kind)!.Value, stableId);
		// Short references are unique in a tenant and the allocation checks before it inserts, so creates of one tenant take turns here.
		await Execute("SELECT pg_advisory_xact_lock(hashtext(@tenantId), hashtext('short-reference'))", new { tenantId });
		var shortReference = await workspace.AllocateShortReferenceAsync(kind, stableId);

		// A project owns itself. Any other entity joins the project of its parent, or else the project of the request.
		var entityProjectId = kind == "project"
			? stableId
			: (parent is null ? null : await GetProjectIdAsync(parent.Id)) ?? projectId;

		await Execute(
			"""
			INSERT INTO entities (tenant_id, id, reference, short_reference, created_by, updated_by, kind, title, status, body, body_source, category, priority, type, revision, content_hash, project_id, created_at, updated_at)
			VALUES (@tenantId, @id::uuid, @reference, @shortReference, @actorId::uuid, @actorId::uuid, @kind, @title, @status, @body, 'authored', @category, @priority, @type, 1, @contentHash, @entityProjectId::uuid, @now, @now)
			""",
			new
			{
				tenantId,
				id = stableId,
				reference,
				shortReference,
				actorId,
				kind,
				title,
				status,
				body,
				category = request.Category,
				priority = request.Priority,
				type = request.Type,
				contentHash = ContentHash.ForEntity(title, body),
				entityProjectId,
				now,
			});

		if (parent is not null && relationType is not null)
		{
			await Execute(
				"INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES (@tenantId, @fromId::uuid, @toId::uuid, @relationType, @now) ON CONFLICT DO NOTHING",
				new { tenantId, fromId = parent.Id, toId = stableId, relationType, now });
		}

		// The first revision is a patch from the entity to itself, so every revision of the chain has a ledger row, including this one.
		var structuralParentId = parent is not null && relationType is not null && EntityRules.IsStructuralRelationType(relationType) ? parent.Id : null;
		await AppendFirstRevisionAsync(stableId, entityProjectId!, actorId, now, structuralParentId);

		return (await GetEntityOrThrowAsync(stableId)).ToSummary();
	}

	private async Task AppendFirstRevisionAsync(string entityId, string entityProjectId, string actorId, string now, string? structuralParentId)
	{
		var row = (await Query<EntityRow>($"SELECT {EntityColumns}, entities.tombstone AS Tombstone FROM entities WHERE entities.tenant_id = @tenantId AND entities.id = @entityId::uuid", new { tenantId, entityId })).Single();
		var state = new JsonObject
		{
			["title"] = row.Title,
			["body"] = row.Body ?? string.Empty,
			["bodySource"] = row.BodySource,
			["category"] = row.Category,
			["priority"] = row.Priority,
			["type"] = row.Type,
			["status"] = row.Status,
			["parentId"] = structuralParentId,
			["tombstone"] = false,
		};
		var transition = ReverseFieldPatch.Create(state, (JsonObject)state.DeepClone(), ReversePatchRegistry.For(RevisionPatchRecordKind.Entity));
		await Execute(
			"""
			INSERT INTO revision_entries (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
			VALUES (@id, @tenantId, @entityProjectId::uuid, 'entity', @recordKey, 1, @actorId, @patchFormat, @reversePatch, @sourceHash, @targetHash, NULL, @now)
			""",
			new
			{
				id = Guid.NewGuid().ToString("D"),
				tenantId,
				entityProjectId,
				recordKey = RevisionPatchRecordKey.Encode(RevisionPatchRecordKind.Entity, entityId),
				actorId,
				patchFormat = transition.PatchFormat,
				reversePatch = transition.ReversePatch,
				sourceHash = Convert.FromHexString(transition.SourceHash),
				targetHash = Convert.FromHexString(transition.TargetHash),
				now,
			});
	}

	/// <summary>Registers the user of the login in the tenant when it is new, and returns its ID.</summary>
	private async Task<string> UpsertUserAsync(string authenticationSubject)
	{
		var user = StableIdentity.DeriveUser(authenticationSubject);
		var now = TenantWorkspace.Now();
		await Execute(
			"INSERT INTO users (tenant_id, id, authentication_subject, display_name, created_at, updated_at) VALUES (@tenantId, @id::uuid, @subject, NULL, @now, @now) ON CONFLICT DO NOTHING",
			new { tenantId, id = user.Id, subject = user.AuthenticationSubject, now });
		return user.Id;
	}

	/// <summary>
	/// The epic that an initiative without a parent joins: the epic of the current project, so an initiative that is created in a workspace
	/// lands in that workspace's project. Without an identity, or when the project has no epic, it is the epic of the default project.
	/// </summary>
	private async Task<string> ResolveDefaultEpicIdAsync()
	{
		if (selector is null)
		{
			return DefaultWorkspace.Epic.StableId;
		}

		var epics = await Query<string>(
			"""
			SELECT entities.id::text
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			WHERE relations.tenant_id = @tenantId AND relations.from_id = @projectId::uuid AND relations.type = 'contains' AND entities.kind = 'epic'
			ORDER BY entities.id
			LIMIT 1
			""",
			new { tenantId, projectId });
		return epics.Count > 0 ? epics[0] : DefaultWorkspace.Epic.StableId;
	}

	// ---- read ----

	public async Task<EntityDetails> GetDetailsAsync(string entityId)
	{
		var projectScoped = selector is not null;
		var entity = await GetEntityOrThrowAsync(entityId);

		var incomingScope = projectScoped
			? "AND (entities.project_id = @projectId::uuid OR (entities.id = @projectId::uuid AND relations.type = ANY(@structural)))"
			: string.Empty;
		var outgoingScope = projectScoped ? "AND entities.project_id = @projectId::uuid" : string.Empty;
		var structural = EntityRules.StructuralRelationTypes.ToArray();
		var incoming = await Query<LinkRow>(
			$"""
			SELECT relations.type AS RelationType, {SummaryColumns}
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			WHERE relations.tenant_id = @tenantId AND relations.to_id = @entityId::uuid {incomingScope}
				AND entities.tombstone = false
			ORDER BY entities.id
			""",
			new { tenantId, entityId = entity.Id, projectId, structural });
		var outgoing = await Query<LinkRow>(
			$"""
			SELECT relations.type AS RelationType, {SummaryColumns}
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			WHERE relations.tenant_id = @tenantId AND relations.from_id = @entityId::uuid {outgoingScope}
				AND entities.tombstone = false
			ORDER BY entities.id
			""",
			new { tenantId, entityId = entity.Id, projectId });

		var statuses = await GetDerivedStatusesAsync();
		var observations = entity.Kind == "issue" ? await ListCompletionObservationsAsync(entity.Id) : [];
		var details = new EntityDetails(
			entity.ToRecord(StatusOf(statuses, entity.Id, entity.Status)),
			[.. incoming.Select(row => new EntityRelationLink(row.RelationType, row.ToSummary(StatusOf(statuses, row.Id, row.Status))))],
			[.. outgoing.Select(row => new EntityRelationLink(row.RelationType, row.ToSummary(StatusOf(statuses, row.Id, row.Status))))],
			PlanEntries: [],
			observations,
			observations.Count > 0 ? observations[^1] : null,
			VersionCoverage: []);

		if (entity.Kind != "issue")
		{
			if (projectScoped && !await ProjectEntityExistsAsync(entityId, includeTombstone: false))
			{
				throw new EntityException($"Entity not found: {entityId}");
			}

			return details;
		}

		if (!await ProjectIssueExistsAsync(entity.Id))
		{
			if (projectScoped)
			{
				var project = (await Query<(string Title, string Reference)>(
					"SELECT title AS Title, reference AS Reference FROM entities WHERE tenant_id = @tenantId AND id = @projectId::uuid AND kind = 'project' AND tombstone = false",
					new { tenantId, projectId })).FirstOrDefault();
				throw new EntityException(project.Title is null
					? $"Entity not found: {entityId}"
					: $"Entity not found in current project \"{project.Title}\" ({project.Reference}): {entityId}");
			}
		}

		// Comments are not ported: no feature creates them yet, so the page of every issue is empty.
		return details with { Comments = new IssueCommentPage([], [], 0, null) };
	}

	public async Task<InitiativeBundle> GetInitiativeBundleAsync(string initiativeId)
	{
		var initiative = await GetEntityOrThrowAsync(initiativeId);
		if (initiative.Kind != "initiative")
		{
			throw new EntityException($"{initiativeId} is not an initiative.");
		}

		// Everything that the initiative reaches along relations, and the handoffs that point at what it reaches.
		var reachable = await Query<string>(
			"""
			WITH RECURSIVE reachable(id) AS (
				SELECT @initiativeId::uuid
				UNION
				SELECT CASE WHEN relations.from_id = reachable.id THEN relations.to_id ELSE relations.from_id END
				FROM reachable
				JOIN relations ON (relations.from_id = reachable.id OR (relations.type = 'handsOff' AND relations.to_id = reachable.id))
				JOIN entities AS next_entity ON next_entity.tenant_id = relations.tenant_id
					AND next_entity.id = CASE WHEN relations.from_id = reachable.id THEN relations.to_id ELSE relations.from_id END
				WHERE relations.tenant_id = @tenantId AND next_entity.tombstone = false
			)
			SELECT id::text FROM reachable
			""",
			new { tenantId, initiativeId = initiative.Id });
		var rows = await Query<EntityRow>(
			$"SELECT {EntityColumns} FROM entities WHERE entities.tenant_id = @tenantId AND entities.tombstone = false AND entities.id = ANY(@ids::uuid[]) ORDER BY entities.id",
			new { tenantId, ids = reachable.ToArray() });
		var relations = await Query<RelationRow>(
			"SELECT from_id::text AS FromId, to_id::text AS ToId, type AS Type FROM relations WHERE tenant_id = @tenantId ORDER BY from_id, to_id, type",
			new { tenantId });

		var statuses = await GetDerivedStatusesAsync();
		var entities = rows.Select(row => row.ToRecord(StatusOf(statuses, row.Id, row.Status))).ToList();
		var byId = entities.ToDictionary(entity => entity.Id);
		var selected = relations.Where(relation => byId.ContainsKey(relation.FromId) && byId.ContainsKey(relation.ToId)).ToList();
		List<T> Links<T>(string type, Func<EntityRecord, EntityRecord, T> link) =>
			[.. selected.Where(relation => relation.Type == type).Select(relation => link(byId[relation.FromId], byId[relation.ToId]))];

		return new InitiativeBundle(
			initiative.ToRecord(StatusOf(statuses, initiative.Id, initiative.Status)),
			entities,
			[.. entities.Where(entity => entity.Kind == "prd")],
			[.. entities.Where(entity => entity.Kind == "userStory")],
			[.. entities.Where(entity => entity.Kind == "adr")],
			[.. entities.Where(entity => entity.Kind == "issue")],
			Links("fixes", (issue, story) => new InitiativeFixLink(issue, story)),
			Links("decomposes", (parent, issue) => new InitiativeSubIssueLink(parent, issue)),
			Links("blocks", (source, target) => new InitiativeBlockerLink(source, target)),
			Links("constrains", (adr, issue) => new InitiativeConstrainsLink(adr, issue)),
			VersionCoverage: []);
	}

	public async Task<IReadOnlyList<EntitySummary>> ListAsync(string? kind)
	{
		if (!EntityRules.IsKind(kind))
		{
			throw new EntityException($"Unknown entity kind: {kind ?? "undefined"}");
		}

		var rows = await Query<SummaryRow>(
			$"SELECT {SummaryColumns} FROM entities WHERE entities.tenant_id = @tenantId AND entities.project_id = @projectId::uuid AND entities.tombstone = false ORDER BY entities.id",
			new { tenantId, projectId });
		var statuses = await GetDerivedStatusesAsync();
		return [.. rows.Where(row => row.Kind == kind).Select(row => row.ToSummary(StatusOf(statuses, row.Id, row.Status)))];
	}

	public async Task<QueryEntitiesResult> QueryAsync(QueryEntitiesRequest request)
	{
		if (!EntityRules.IsKind(request.Kind))
		{
			throw new EntityException($"Unknown entity kind: {request.Kind ?? "undefined"}");
		}

		var kind = request.Kind!;
		var isIssue = kind == "issue";
		IReadOnlyDictionary<string, IReadOnlyList<string>>? NoBlockers() => isIssue ? new Dictionary<string, IReadOnlyList<string>>() : null;

		EntityRow? parent = null;
		if (!string.IsNullOrEmpty(request.ParentId))
		{
			parent = await ResolveEntityAsync(request.ParentId, includeTombstone: false, projectId);
			if (parent is null)
			{
				return new QueryEntitiesResult([], 0) { OpenBlockers = NoBlockers() };
			}
		}

		var selectedIds = parent is null
			? await Query<string>(
				"SELECT id::text FROM entities WHERE tenant_id = @tenantId AND project_id = @projectId::uuid AND tombstone = false AND kind = @kind ORDER BY id",
				new { tenantId, projectId, kind })
			: await Query<string>(
				"""
				SELECT entity.id::text
				FROM entities AS entity
				JOIN relations AS parent_relation ON parent_relation.tenant_id = entity.tenant_id AND parent_relation.to_id = entity.id
				WHERE entity.tenant_id = @tenantId
					AND entity.project_id = @projectId::uuid
					AND entity.tombstone = false
					AND entity.kind = @kind
					AND parent_relation.from_id = @parentId::uuid
					AND parent_relation.type = ANY(@structural)
				ORDER BY entity.id
				""",
				new { tenantId, projectId, kind, parentId = parent.Id, structural = EntityRules.StructuralRelationTypes.ToArray() });

		var statuses = await GetDerivedStatusesAsync();
		var selected = request.Statuses is { Count: > 0 }
			? selectedIds.Where(id => request.Statuses.Contains(StatusOf(statuses, id, string.Empty))).ToList()
			: [.. selectedIds];
		var total = selected.Count;
		var limited = request.Limit is { } limit ? selected.Take(SliceEnd(limit, selected.Count)).ToList() : selected;
		if (limited.Count == 0)
		{
			return new QueryEntitiesResult([], total) { OpenBlockers = NoBlockers() };
		}

		var rows = (await Query<SummaryRow>(
			$"SELECT {SummaryColumns} FROM entities WHERE entities.tenant_id = @tenantId AND entities.project_id = @projectId::uuid AND entities.id = ANY(@ids::uuid[])",
			new { tenantId, projectId, ids = limited.Distinct().ToArray() })).ToDictionary(row => row.Id);
		var entities = limited.Select(id => rows[id].ToSummary(StatusOf(statuses, id, rows[id].Status))).ToList();

		return new QueryEntitiesResult(entities, total) { OpenBlockers = isIssue ? await GetOpenBlockersAsync(entities, statuses) : null };
	}

	/// <summary>
	/// The end of <c>slice(0, limit)</c> in JavaScript: a fraction is cut off, and a negative limit counts back from the end of the list.
	/// </summary>
	private static int SliceEnd(double limit, int count)
	{
		var end = double.IsNaN(limit) ? 0 : Math.Truncate(limit);
		return (int)Math.Clamp(end < 0 ? count + end : end, 0, count);
	}

	/// <summary>Maps the reference of each issue to the references of its open (not done) blocking issues.</summary>
	private async Task<IReadOnlyDictionary<string, IReadOnlyList<string>>> GetOpenBlockersAsync(List<EntitySummary> issues, Dictionary<string, string> statuses)
	{
		var openBlockers = new Dictionary<string, IReadOnlyList<string>>();
		var referenceById = issues.ToDictionary(issue => issue.Id, issue => issue.Reference);
		foreach (var issue in issues)
		{
			openBlockers[issue.Reference] = [];
		}

		if (issues.Count == 0)
		{
			return openBlockers;
		}

		var blocks = await Query<RelationRow>(
			"""
			SELECT relations.from_id::text AS FromId, relations.to_id::text AS ToId, relations.type AS Type
			FROM relations
			JOIN entities AS source ON source.tenant_id = relations.tenant_id AND source.id = relations.from_id
			WHERE relations.tenant_id = @tenantId
				AND relations.type = 'blocks'
				AND relations.to_id = ANY(@issueIds::uuid[])
				AND source.project_id = @projectId::uuid
				AND source.tombstone = false
			""",
			new { tenantId, projectId, issueIds = issues.Select(issue => issue.Id).ToArray() });
		if (blocks.Count == 0)
		{
			return openBlockers;
		}

		var missing = blocks.Select(block => block.FromId).Distinct().Where(id => !referenceById.ContainsKey(id)).ToArray();
		if (missing.Length > 0)
		{
			foreach (var row in await Query<(string Id, string Reference)>(
				"SELECT id::text AS Id, reference AS Reference FROM entities WHERE tenant_id = @tenantId AND project_id = @projectId::uuid AND id = ANY(@ids::uuid[])",
				new { tenantId, projectId, ids = missing }))
			{
				referenceById[row.Id] = row.Reference;
			}
		}

		var lists = issues.ToDictionary(issue => issue.Reference, _ => new List<string>());
		foreach (var block in blocks)
		{
			if (statuses.TryGetValue(block.FromId, out var sourceStatus) && sourceStatus != "done")
			{
				lists[referenceById[block.ToId]].Add(referenceById[block.FromId]);
			}
		}

		foreach (var (reference, list) in lists)
		{
			openBlockers[reference] = list;
		}

		return openBlockers;
	}

	// ---- shared reads ----

	/// <summary>
	/// The derived status of every live entity of the current project. It reads the whole project, which is one entity query and one
	/// relation query, so the status of any entity is the status that the whole graph gives it.
	/// </summary>
	private async Task<Dictionary<string, string>> GetDerivedStatusesAsync()
	{
		var entities = await Query<StatusEntityRow>(
			"SELECT id::text AS Id, kind AS Kind, status AS Status FROM entities WHERE tenant_id = @tenantId AND project_id = @projectId::uuid AND tombstone = false",
			new { tenantId, projectId });
		var relations = await Query<RelationRow>(
			"""
			SELECT relations.from_id::text AS FromId, relations.to_id::text AS ToId, relations.type AS Type
			FROM relations
			JOIN entities AS source ON source.tenant_id = relations.tenant_id AND source.id = relations.from_id
			JOIN entities AS target ON target.tenant_id = relations.tenant_id AND target.id = relations.to_id
			WHERE relations.tenant_id = @tenantId
				AND source.project_id = @projectId::uuid
				AND target.project_id = @projectId::uuid
				AND source.tombstone = false
				AND target.tombstone = false
			""",
			new { tenantId, projectId });
		return EntityStatusDerivation.Derive(
			[.. entities.Select(row => new StatusEntity(row.Id, row.Kind, row.Status))],
			[.. relations.Select(row => new StatusRelation(row.FromId, row.ToId, row.Type))]);
	}

	/// <summary>The derived status of an entity, or its stored status when it is not part of the current project.</summary>
	private static string StatusOf(Dictionary<string, string> statuses, string id, string stored) =>
		statuses.TryGetValue(id, out var derived) ? derived : stored;

	private async Task<IReadOnlyList<CompletionObservation>> ListCompletionObservationsAsync(string issueId)
	{
		var rows = await Query<CompletionObservationRow>(
			"""
			SELECT id::text AS Id, issue_id::text AS IssueId, completion_ordinal AS CompletionOrdinal, repository_identity AS RepositoryIdentity,
				commit_sha AS CommitSha, branch AS Branch, dirty AS Dirty, captured_at AS CapturedAt, calculated_version_state AS CalculatedVersionState,
				calculated_version AS CalculatedVersion, diagnostics AS Diagnostics
			FROM completion_observations
			WHERE tenant_id = @tenantId AND issue_id = @issueId::uuid
			ORDER BY completion_ordinal
			""",
			new { tenantId, issueId });
		return
		[
			.. rows.Select(row => new CompletionObservation(
				row.Id,
				row.IssueId,
				row.CompletionOrdinal,
				row.RepositoryIdentity,
				row.CommitSha,
				row.Branch,
				row.Dirty,
				row.CapturedAt,
				row.CalculatedVersionState,
				row.CalculatedVersion,
				JsonSerializer.Deserialize<List<CompletionDiagnostic>>(row.Diagnostics, DiagnosticOptions) ?? [])),
		];
	}

	private async Task<EntityRow> GetEntityOrThrowAsync(string entityId) =>
		await ResolveEntityAsync(entityId, includeTombstone: false, projectFilter: null)
		?? throw new EntityException($"Entity not found: {entityId}");

	/// <summary>
	/// The entity that a selector names: the entity with that stable ID or reference, and only when there is none, the entity with that short
	/// reference. References and short references are unique in a tenant, so a selector names at most one entity.
	/// </summary>
	private async Task<EntityRow?> ResolveEntityAsync(string selector, bool includeTombstone, string? projectFilter)
	{
		var live = includeTombstone ? string.Empty : " AND entities.tombstone = false";
		var scope = projectFilter is null ? string.Empty : " AND entities.project_id = @projectFilter::uuid";
		var parameters = new { tenantId, selector, projectFilter };
		var byIdentity = UuidPattern().IsMatch(selector) ? "entities.id = @selector::uuid" : "entities.reference = @selector";
		var rows = await Query<EntityRow>(
			$"SELECT {EntityColumns} FROM entities WHERE entities.tenant_id = @tenantId AND {byIdentity}{scope}{live}",
			parameters);
		if (rows.Count > 0)
		{
			return rows[0];
		}

		return (await Query<EntityRow>(
			$"SELECT {EntityColumns} FROM entities WHERE entities.tenant_id = @tenantId AND entities.short_reference = @selector{scope}{live}",
			parameters)).FirstOrDefault();
	}

	private async Task<string?> GetProjectIdAsync(string entityId) =>
		(await Query<string?>("SELECT project_id::text FROM entities WHERE tenant_id = @tenantId AND id = @entityId::uuid", new { tenantId, entityId })).FirstOrDefault();

	private async Task<bool> ProjectEntityExistsAsync(string entityId, bool includeTombstone) =>
		(await Query<string>(
			$"""
			SELECT entities.id::text FROM entities
			WHERE entities.tenant_id = @tenantId AND entities.project_id = @projectId::uuid
				{(includeTombstone ? string.Empty : "AND entities.tombstone = false")}
				AND (entities.id::text = @entityId OR entities.reference = @entityId)
			""",
			new { tenantId, projectId, entityId })).Count > 0;

	private async Task<bool> ProjectIssueExistsAsync(string issueId) =>
		(await Query<string>(
			"""
			SELECT entities.id::text FROM entities
			WHERE entities.tenant_id = @tenantId AND entities.project_id = @projectId::uuid AND entities.kind = 'issue' AND entities.tombstone = false
				AND (entities.id::text = @issueId OR entities.reference = @issueId)
			""",
			new { tenantId, projectId, issueId })).Count > 0;

	private Task<int> Execute(string sql, object parameters) =>
		connection.ExecuteAsync(new CommandDefinition(sql, parameters, transaction, cancellationToken: cancellationToken));

	private async Task<List<T>> Query<T>(string sql, object parameters) =>
		(await connection.QueryAsync<T>(new CommandDefinition(sql, parameters, transaction, cancellationToken: cancellationToken))).AsList();

	[GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.IgnoreCase)]
	private static partial Regex UuidPattern();

	private sealed record StatusEntityRow(string Id, string Kind, string Status);

	private sealed class CompletionObservationRow
	{
		public string Id { get; init; } = "";

		public string IssueId { get; init; } = "";

		public int CompletionOrdinal { get; init; }

		public string? RepositoryIdentity { get; init; }

		public string? CommitSha { get; init; }

		public string? Branch { get; init; }

		public bool? Dirty { get; init; }

		public string CapturedAt { get; init; } = "";

		public string CalculatedVersionState { get; init; } = "";

		public string? CalculatedVersion { get; init; }

		public string Diagnostics { get; init; } = "[]";
	}
}
