using AgentLogbook.Core.ContentHashes;
using AgentLogbook.Core.Identity;
using AgentLogbook.Core.ProjectIdentity;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Core.Workspaces;
using Dapper;
using Npgsql;

namespace AgentLogbook.Storage.Postgres.Workspaces;

/// <summary>
/// The workspace of one tenant inside an open tenant transaction: the per-kind counters, the default project and epic, and the
/// project that a project identity names. It is the port of the TypeScript <c>ensurePgTenant</c>, <c>getOrCreateProjectByIdentity</c>
/// and <c>resolveCurrentProjectId</c>. Every storage feature that needs the current project goes through it.
/// </summary>
internal sealed class TenantWorkspace(NpgsqlConnection connection, NpgsqlTransaction transaction, string tenantId, CancellationToken cancellationToken)
{
	private static readonly string[] EntityKinds =
		["project", "epic", "version", "initiative", "prd", "userStory", "adr", "issue", "debt", "handoff", "plan"];

	internal static string Now() => DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

	/// <summary>
	/// The project that the requests of one workspace act in: the project that <paramref name="projectIdentity"/> names, registered on
	/// first use, or the default project when there is no identity. This is the TypeScript <c>resolveCurrentProjectId</c>: without an
	/// identity it does not refuse a tenant that has several projects, it picks the default one.
	/// </summary>
	public async Task<string> ResolveCurrentProjectIdAsync(string? projectIdentity)
	{
		var selector = projectIdentity?.Trim();
		if (!string.IsNullOrEmpty(selector))
		{
			return (await OpenByIdentityAsync(selector)).Project.Id;
		}

		await EnsureTenantAsync();
		return DefaultWorkspace.Project.StableId;
	}

	public async Task<InitializedWorkspace> OpenDefaultAsync()
	{
		var seeded = await EnsureTenantAsync();
		var project = await ReadEntityAsync(DefaultWorkspace.Project.StableId);
		var epic = await ReadEntityAsync(DefaultWorkspace.Epic.StableId);
		return Describe(project, epic, created: seeded);
	}

	public async Task<InitializedWorkspace> OpenByIdentityAsync(string identity)
	{
		// The lock is held until the transaction ends and is taken before anything is seeded or read, so two first calls
		// for the same new workspace take turns. Two projects with one title would make the identity ambiguous for good.
		await Execute("SELECT pg_advisory_xact_lock(hashtext(@tenantId), hashtext(@identity))", new { tenantId, identity });
		await EnsureTenantAsync();

		var direct = await Query<WorkspaceRow>(
			"""
			SELECT id::text AS Id, reference AS Reference, short_reference AS ShortReference, title AS Title
			FROM entities
			WHERE tenant_id = @tenantId AND kind = 'project' AND tombstone = false
				AND (id::text = @identity OR reference = @identity)
			LIMIT 1
			""",
			new { tenantId, identity });
		if (direct.Count > 0)
		{
			var directProject = direct[0];
			return Describe(directProject, await FindEpicAsync(directProject.Id), created: false);
		}

		var wanted = PathSegment.Sanitize(identity);
		var projects = await Query<WorkspaceRow>(
			"""
			SELECT id::text AS Id, reference AS Reference, short_reference AS ShortReference, title AS Title
			FROM entities
			WHERE tenant_id = @tenantId AND kind = 'project' AND tombstone = false
			ORDER BY id
			""",
			new { tenantId });
		var matching = projects.Where(project => PathSegment.Sanitize(project.Title) == wanted).ToList();
		if (matching.Count > 1)
		{
			throw new WorkspaceException($"Ambiguous project identity \"{identity}\" in tenant {tenantId}.");
		}

		if (matching.Count == 1)
		{
			return Describe(matching[0], await FindEpicAsync(matching[0].Id), created: false);
		}

		if (CanonicalReference.IsDirectEntitySelector(identity))
		{
			throw new WorkspaceException($"Cannot resolve project identity \"{identity}\" in tenant {tenantId}.");
		}

		var project = await InsertProjectWithEpicAsync(identity);
		return Describe(project.Project, project.Epic, created: true);
	}

	/// <summary>Seeds the counters and the default project and epic. Returns true when it added the default project.</summary>
	internal async Task<bool> EnsureTenantAsync()
	{
		foreach (var kind in EntityKinds)
		{
			await Execute(
				"INSERT INTO counters (tenant_id, kind, next_value) VALUES (@tenantId, @kind, 1) ON CONFLICT DO NOTHING",
				new { tenantId, kind });
		}

		var now = Now();
		var addedProject = await InsertEntityAsync(DefaultWorkspace.Project, "project", DefaultWorkspace.ProjectTitle, DefaultWorkspace.Project.StableId, now);
		await InsertEntityAsync(DefaultWorkspace.Epic, "epic", DefaultWorkspace.EpicTitle, DefaultWorkspace.Project.StableId, now);
		await InsertContainsAsync(DefaultWorkspace.Project.StableId, DefaultWorkspace.Epic.StableId, now);
		return addedProject;
	}

	private async Task<(WorkspaceRow Project, WorkspaceRow Epic)> InsertProjectWithEpicAsync(string title)
	{
		var now = Now();
		var project = NewIdentity(ReferenceKind.Project);
		var epic = NewIdentity(ReferenceKind.Epic);
		var projectShort = await AllocateShortReferenceAsync("project", project.StableId);
		var epicShort = await AllocateShortReferenceAsync("epic", epic.StableId);

		// A project owns itself, so project-scoped reads and its own revision ledger both resolve.
		await InsertWorkspaceRowAsync(project, "project", title, project.StableId, projectShort, now);
		await InsertWorkspaceRowAsync(epic, "epic", DefaultWorkspace.EpicTitle, project.StableId, epicShort, now);
		await InsertContainsAsync(project.StableId, epic.StableId, now);
		return (
			new WorkspaceRow(project.StableId, project.Reference, projectShort, title),
			new WorkspaceRow(epic.StableId, epic.Reference, epicShort, DefaultWorkspace.EpicTitle));
	}

	private static DerivedIdentity NewIdentity(ReferenceKind kind)
	{
		var stableId = Guid.NewGuid().ToString("D");
		return new DerivedIdentity(stableId, CanonicalReference.Encode(kind, stableId));
	}

	private async Task<bool> InsertEntityAsync(DerivedIdentity identity, string kind, string title, string projectId, string now) =>
		await InsertWorkspaceRowAsync(identity, kind, title, projectId, CanonicalReference.ShortReference(identity.StableId, kind), now);

	private async Task<bool> InsertWorkspaceRowAsync(DerivedIdentity identity, string kind, string title, string projectId, string shortReference, string now) =>
		await Execute(
			"""
			INSERT INTO entities (tenant_id, id, reference, short_reference, kind, title, status, body, body_source, revision, content_hash, project_id, created_at, updated_at)
			VALUES (@tenantId, @id::uuid, @reference, @shortReference, @kind, @title, 'active', '', 'generated', 1, @contentHash, @projectId::uuid, @now, @now)
			ON CONFLICT DO NOTHING
			""",
			new
			{
				tenantId,
				id = identity.StableId,
				reference = identity.Reference,
				shortReference,
				kind,
				title,
				contentHash = ContentHash.ForEntity(title, string.Empty),
				projectId,
				now,
			}) > 0;

	private Task<int> InsertContainsAsync(string fromId, string toId, string now) =>
		Execute(
			"INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES (@tenantId, @fromId::uuid, @toId::uuid, 'contains', @now) ON CONFLICT DO NOTHING",
			new { tenantId, fromId, toId, now });

	internal async Task<string> AllocateShortReferenceAsync(string kind, string id)
	{
		var baseReference = CanonicalReference.ShortReference(id, kind);
		var shortReference = baseReference;
		for (var suffix = 2; await ShortReferenceExistsAsync(shortReference); suffix++)
		{
			shortReference = $"{baseReference}-{suffix}";
		}

		return shortReference;
	}

	private async Task<bool> ShortReferenceExistsAsync(string shortReference) =>
		(await Query<int>(
			"SELECT 1 FROM entities WHERE tenant_id = @tenantId AND short_reference = @shortReference LIMIT 1",
			new { tenantId, shortReference })).Count > 0;

	/// <summary>The first epic that the project contains. Every project that this code registers has one.</summary>
	private async Task<WorkspaceRow> FindEpicAsync(string projectId)
	{
		var epics = await Query<WorkspaceRow>(
			"""
			SELECT entities.id::text AS Id, entities.reference AS Reference, entities.short_reference AS ShortReference, entities.title AS Title
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			WHERE relations.tenant_id = @tenantId AND relations.from_id = @projectId::uuid
				AND relations.type = 'contains' AND entities.kind = 'epic'
			ORDER BY entities.id
			LIMIT 1
			""",
			new { tenantId, projectId });
		return epics.Count > 0
			? epics[0]
			: throw new WorkspaceException($"Project {projectId} in tenant {tenantId} has no epic.");
	}

	private async Task<WorkspaceRow> ReadEntityAsync(string id) =>
		(await Query<WorkspaceRow>(
			"SELECT id::text AS Id, reference AS Reference, short_reference AS ShortReference, title AS Title FROM entities WHERE tenant_id = @tenantId AND id = @id::uuid",
			new { tenantId, id })).Single();

	private InitializedWorkspace Describe(WorkspaceRow project, WorkspaceRow epic, bool created)
	{
		var defaultProject = new WorkspaceEntity(
			DefaultWorkspace.Project.StableId, DefaultWorkspace.Project.Reference,
			CanonicalReference.ShortReference(DefaultWorkspace.Project.StableId, "project"), DefaultWorkspace.ProjectTitle);
		var defaultEpic = new WorkspaceEntity(
			DefaultWorkspace.Epic.StableId, DefaultWorkspace.Epic.Reference,
			CanonicalReference.ShortReference(DefaultWorkspace.Epic.StableId, "epic"), DefaultWorkspace.EpicTitle);
		return new InitializedWorkspace(tenantId, project.ToWire(), epic.ToWire(), created, defaultProject, defaultEpic);
	}

	private Task<int> Execute(string sql, object parameters) =>
		connection.ExecuteAsync(new CommandDefinition(sql, parameters, transaction, cancellationToken: cancellationToken));

	private async Task<IReadOnlyList<T>> Query<T>(string sql, object parameters) =>
		(await connection.QueryAsync<T>(new CommandDefinition(sql, parameters, transaction, cancellationToken: cancellationToken))).AsList();
}

internal sealed record WorkspaceRow(string Id, string Reference, string ShortReference, string Title)
{
	public WorkspaceEntity ToWire() => new(Id, Reference, ShortReference, Title);
}
