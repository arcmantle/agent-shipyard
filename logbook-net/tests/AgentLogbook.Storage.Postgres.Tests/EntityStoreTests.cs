using AgentLogbook.Core.ContentHashes;
using AgentLogbook.Core.Entities;
using AgentLogbook.Core.Identity;
using AgentLogbook.Core.RevisionLedger;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Core.Workspaces;
using AgentLogbook.Storage.Postgres.Entities;
using Npgsql;

namespace AgentLogbook.Storage.Postgres.Tests;

public class EntityStoreTests
{
	private const string Tenant = "tenant-a";

	private static async Task<(TestDatabase Database, NpgsqlDataSource Runtime)> NewDatabaseAsync()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		return (database, database.Runtime());
	}

	private static Task<EntitySummary> CreateAsync(
		NpgsqlDataSource runtime, CreateEntityRequest request, string? identity = null, string tenant = Tenant, string actor = "alice") =>
		EntityStore.CreateAsync(runtime, tenant, identity, actor, request);

	private static CreateEntityRequest Entity(string kind, string title, string? parent = null) =>
		new() { Kind = kind, Title = title, ParentId = parent };

	private static async Task<EntityException> ExpectFailureAsync(Func<Task> action)
	{
		try
		{
			await action();
		}
		catch (EntityException exception)
		{
			return exception;
		}

		throw new InvalidOperationException("The call did not fail.");
	}

	[Test]
	public async Task A_created_entity_keeps_its_identity_literal_hash_nulls_and_first_revision()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var initiative = await CreateAsync(runtime, Entity("initiative", "Parity initiative"));
		var issue = await CreateAsync(runtime, new CreateEntityRequest { Kind = "issue", Title = "Parity issue", ParentId = initiative.Id });

		var user = StableIdentity.DeriveUser("alice");
		await Assert.That(issue.Kind).IsEqualTo("issue");
		await Assert.That(issue.Status).IsEqualTo("todo");
		await Assert.That(issue.Revision).IsEqualTo(1);
		await Assert.That(issue.ContentHash).IsEqualTo("855e6615aa6fc0cb47e41a3fb11291fcee4d6a061c019abb3271d30767c1f414");
		await Assert.That(issue.ContentHash).IsEqualTo(ContentHash.ForEntity("Parity issue", string.Empty));
		await Assert.That(issue.Category).IsNull();
		await Assert.That(issue.Priority).IsNull();
		await Assert.That(issue.Type).IsNull();
		await Assert.That(issue.CreatedBy).IsEqualTo(user.Id);
		await Assert.That(issue.UpdatedBy).IsEqualTo(user.Id);
		await Assert.That(issue.CreatedAt).IsEqualTo(issue.UpdatedAt);
		await Assert.That(issue.CreatedAt).Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$");
		var decoded = CanonicalReference.Decode(issue.Reference);
		await Assert.That(decoded.Kind).IsEqualTo(ReferenceKind.Issue);
		await Assert.That(decoded.StableId).IsEqualTo(issue.Id);
		await Assert.That(issue.ShortReference).IsEqualTo(CanonicalReference.ShortReference(issue.Id, "issue"));

		// The user of the login is registered once, and the entity joins the project of its parent.
		await Assert.That(await database.ScalarAsync<long>($"SELECT count(*) FROM users WHERE id = '{user.Id}' AND authentication_subject = 'alice'")).IsEqualTo(1L);
		await Assert.That(await database.ScalarAsync<long>(
			$"SELECT count(*) FROM entities WHERE id = '{issue.Id}' AND project_id = '{DefaultWorkspace.Project.StableId}' AND body = '' AND body_source = 'authored' AND tombstone = false")).IsEqualTo(1L);
		await Assert.That(await database.ScalarAsync<long>(
			$"SELECT count(*) FROM relations WHERE type = 'tracks' AND from_id = '{initiative.Id}' AND to_id = '{issue.Id}'")).IsEqualTo(1L);

		// The first revision is a patch from the entity to itself, so the chain has a row for every revision.
		await Assert.That(await database.ScalarAsync<long>($"SELECT count(*) FROM revision_entries WHERE record_key = '{RevisionPatchRecordKey.Encode(RevisionPatchRecordKind.Entity, issue.Id)}'")).IsEqualTo(1L);
		await Assert.That(await database.ScalarAsync<long>(
			$"SELECT count(*) FROM revision_entries WHERE record_kind = 'entity' AND revision = 1 AND author = '{user.Id}' AND patch_format = 1 AND octet_length(reverse_patch) = 0 AND source_hash = target_hash AND project_id = '{DefaultWorkspace.Project.StableId}' AND restored_from_revision IS NULL")).IsEqualTo(2L);
	}

	[Test]
	public async Task The_first_revision_hash_is_the_hash_of_the_canonical_state_with_the_structural_parent()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));
		var issue = await CreateAsync(runtime, new CreateEntityRequest { Kind = "issue", Title = "Issue", ParentId = initiative.Id, Body = "Body", Priority = "high", Category = "technical" });

		var state = new System.Text.Json.Nodes.JsonObject
		{
			["title"] = "Issue",
			["body"] = "Body",
			["bodySource"] = "authored",
			["category"] = "technical",
			["priority"] = "high",
			["type"] = null,
			["status"] = "todo",
			["parentId"] = initiative.Id,
			["tombstone"] = false,
		};
		var expected = ReverseFieldPatch.ComputeCanonicalStateHash(state, ReversePatchRegistry.For(RevisionPatchRecordKind.Entity));
		var stored = await database.ScalarAsync<string>(
			$"SELECT encode(target_hash, 'hex') FROM revision_entries WHERE record_key = '{RevisionPatchRecordKey.Encode(RevisionPatchRecordKind.Entity, issue.Id)}'");

		await Assert.That(stored).IsEqualTo(expected);
	}

	[Test]
	public async Task A_title_is_trimmed_before_it_is_stored_and_hashed()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var created = await CreateAsync(runtime, new CreateEntityRequest { Kind = "project", Title = "  Padded title  ", Body = "Body" });

		await Assert.That(created.Title).IsEqualTo("Padded title");
		await Assert.That(created.ContentHash).IsEqualTo(ContentHash.ForEntity("Padded title", "Body"));
	}

	[Test]
	public async Task A_project_owns_itself_and_is_not_registered_in_another_project()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var project = await CreateAsync(runtime, Entity("project", "Own project"));

		await Assert.That(await database.ScalarAsync<long>($"SELECT count(*) FROM entities WHERE id = '{project.Id}' AND project_id = id")).IsEqualTo(1L);
	}

	[Test]
	public async Task The_status_override_is_checked_against_the_kind_and_a_plan_always_starts_as_draft()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));

		var issue = await CreateAsync(runtime, new CreateEntityRequest { Kind = "issue", Title = "Started", ParentId = initiative.Id, Status = "in-progress" });
		var plan = await CreateAsync(runtime, new CreateEntityRequest { Kind = "plan", Title = "Plan", ParentId = initiative.Id, Status = "ready" });

		await Assert.That(issue.Status).IsEqualTo("in-progress");
		await Assert.That(plan.Status).IsEqualTo("draft");
	}

	[Test]
	[Arguments("bogus", "x", null, null, null, null, null, "Unknown entity kind: bogus")]
	[Arguments(null, "x", null, null, null, null, null, "Unknown entity kind: undefined")]
	[Arguments("initiative", "   ", null, null, null, null, null, "Entity title must not be empty.")]
	[Arguments("initiative", null, null, null, null, null, null, "Entity title must not be empty.")]
	[Arguments("initiative", "x", "todo", null, null, null, null, "Invalid status for initiative: todo")]
	[Arguments("initiative", "x", null, "bogus", null, null, null, "Invalid entity category: bogus")]
	[Arguments("initiative", "x", null, null, "bogus", null, null, "Invalid entity priority: bogus")]
	[Arguments("initiative", "x", null, null, null, "pioneer-map", null, "Invalid entity type: pioneer-map")]
	[Arguments("debt", "x", null, "technical", null, null, null, "Debt requires category and priority.")]
	[Arguments("debt", "x", null, "technical", "high", null, null, "Debt requires a project, epic, initiative, or issue owner.")]
	[Arguments("plan", "x", null, null, null, null, null, "Plan requires an initiative parent.")]
	[Arguments("issue", "x", null, null, null, null, "missing", "Entity not found: missing")]
	[Arguments("epic", "x", null, null, null, null, "INITIATIVE", "Cannot create epic under initiative.")]
	[Arguments("issue", "x", null, null, null, "pioneer-map", "ISSUE", "pioneer-map requires an initiative parent.")]
	[Arguments("issue", "x", null, null, null, "pioneer-ticket", "ISSUE", "pioneer-ticket requires a pioneer-map parent.")]
	public async Task A_request_that_breaks_a_workflow_rule_fails_with_the_message_of_the_rule_and_writes_nothing(
		string? kind, string? title, string? status, string? category, string? priority, string? type, string? parent, string message)
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));
		var issue = await CreateAsync(runtime, Entity("issue", "Issue", initiative.Id));
		var before = await database.ScalarAsync<long>("SELECT count(*) FROM entities");

		var failure = await ExpectFailureAsync(() => CreateAsync(runtime, new CreateEntityRequest
		{
			Kind = kind,
			Title = title,
			Status = status,
			Category = category,
			Priority = priority,
			Type = type,
			ParentId = parent switch { "INITIATIVE" => initiative.Id, "ISSUE" => issue.Id, _ => parent },
		}));

		await Assert.That(failure.Message).IsEqualTo(message);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities")).IsEqualTo(before);
	}

	[Test]
	public async Task Links_are_refused_until_the_link_feature_is_ported()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var failure = await ExpectFailureAsync(() => CreateAsync(runtime, new CreateEntityRequest
		{
			Kind = "initiative",
			Title = "x",
			Links = [new EntityLinkRequest("relatesTo", "ISS_1")],
		}));

		await Assert.That(failure.Message).Contains("Relations cannot be created together with an entity");
	}

	[Test]
	public async Task A_parent_is_found_by_stable_id_reference_or_short_reference()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));

		foreach (var selector in new[] { initiative.Id, initiative.Reference, initiative.ShortReference })
		{
			var issue = await CreateAsync(runtime, Entity("issue", $"Under {selector}", selector));
			var details = await EntityStore.GetDetailsAsync(runtime, Tenant, null, issue.Id);

			await Assert.That(details.Incoming.Single().Entity.Id).IsEqualTo(initiative.Id);
			await Assert.That(details.Incoming.Single().RelationType).IsEqualTo("tracks");
		}
	}

	[Test]
	public async Task An_initiative_without_a_parent_joins_the_epic_of_the_project_of_the_request()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var inDefault = await CreateAsync(runtime, Entity("initiative", "Default initiative"));
		var inProject = await CreateAsync(runtime, Entity("initiative", "Project initiative"), identity: "my-repo");

		var workspace = await Workspaces.WorkspaceInitializer.InitializeAsync(runtime, Tenant, "my-repo");
		await Assert.That(await database.ScalarAsync<long>(
			$"SELECT count(*) FROM relations WHERE type = 'contains' AND from_id = '{DefaultWorkspace.Epic.StableId}' AND to_id = '{inDefault.Id}'")).IsEqualTo(1L);
		await Assert.That(await database.ScalarAsync<long>(
			$"SELECT count(*) FROM relations WHERE type = 'contains' AND from_id = '{workspace.Epic.Id}' AND to_id = '{inProject.Id}'")).IsEqualTo(1L);
		await Assert.That(await database.ScalarAsync<long>($"SELECT count(*) FROM entities WHERE id = '{inProject.Id}' AND project_id = '{workspace.Project.Id}'")).IsEqualTo(1L);
	}

	[Test]
	public async Task Details_show_the_relations_the_derived_status_and_for_an_issue_an_empty_comment_page()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));
		var issue = await CreateAsync(runtime, new CreateEntityRequest { Kind = "issue", Title = "Issue", ParentId = initiative.Id, Body = "Body text" });
		var sub = await CreateAsync(runtime, Entity("issue", "Sub issue", issue.Id));

		var issueDetails = await EntityStore.GetDetailsAsync(runtime, Tenant, null, issue.Reference);
		var initiativeDetails = await EntityStore.GetDetailsAsync(runtime, Tenant, null, initiative.Id);

		await Assert.That(issueDetails.Entity.Body).IsEqualTo("Body text");
		await Assert.That(issueDetails.Entity.BodySource).IsEqualTo("authored");
		await Assert.That(issueDetails.Entity.Status).IsEqualTo("blocked");
		await Assert.That(issueDetails.Incoming.Select(link => (link.RelationType, link.Entity.Id))).IsEquivalentTo([("tracks", initiative.Id)]);
		await Assert.That(issueDetails.Outgoing.Select(link => (link.RelationType, link.Entity.Id, link.Entity.Status))).IsEquivalentTo([("decomposes", sub.Id, "todo")]);
		await Assert.That(issueDetails.Comments).IsNotNull();
		await Assert.That(issueDetails.Comments!.Total).IsEqualTo(0);
		await Assert.That(issueDetails.CompletionObservations).IsEmpty();
		await Assert.That(issueDetails.CurrentCompletionObservation).IsNull();
		await Assert.That(issueDetails.PlanEntries).IsEmpty();
		await Assert.That(issueDetails.VersionCoverage).IsEmpty();
		await Assert.That(initiativeDetails.Comments).IsNull();
		await Assert.That(initiativeDetails.Entity.Status).IsEqualTo("active");
		await Assert.That(initiativeDetails.Entity.Body).IsEmpty();
		await Assert.That(initiativeDetails.Incoming.Single().Entity.Title).IsEqualTo("Default Epic");
		await Assert.That(initiativeDetails.Incoming.Single().Entity.CreatedBy).IsEqualTo("system");
	}

	[Test]
	public async Task Details_of_a_missing_entity_fail()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var failure = await ExpectFailureAsync(() => EntityStore.GetDetailsAsync(runtime, Tenant, null, "missing"));

		await Assert.That(failure.Message).IsEqualTo("Entity not found: missing");
	}

	[Test]
	public async Task A_workspace_with_an_identity_sees_only_the_entities_of_its_project()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var inDefault = await CreateAsync(runtime, Entity("initiative", "Default initiative"));
		var inProject = await CreateAsync(runtime, Entity("initiative", "Project initiative"), identity: "my-repo");
		var issueInProject = await CreateAsync(runtime, Entity("issue", "Project issue", inProject.Id), identity: "my-repo");

		var projectList = await EntityStore.ListAsync(runtime, Tenant, "my-repo", "initiative");
		var defaultList = await EntityStore.ListAsync(runtime, Tenant, null, "initiative");
		var failure = await ExpectFailureAsync(() => EntityStore.GetDetailsAsync(runtime, Tenant, "my-repo", inDefault.Id));
		var issueFailure = await ExpectFailureAsync(() => EntityStore.GetDetailsAsync(runtime, Tenant, "other-repo", issueInProject.Id));
		var visible = await EntityStore.GetDetailsAsync(runtime, Tenant, "my-repo", issueInProject.Id);

		await Assert.That(projectList.Select(entity => entity.Id)).IsEquivalentTo([inProject.Id]);
		await Assert.That(defaultList.Select(entity => entity.Id)).IsEquivalentTo([inDefault.Id]);
		await Assert.That(failure.Message).IsEqualTo($"Entity not found: {inDefault.Id}");
		await Assert.That(issueFailure.Message).Contains("Entity not found in current project \"other-repo\"");
		await Assert.That(visible.Entity.Id).IsEqualTo(issueInProject.Id);
		await Assert.That(visible.Comments).IsNotNull();
	}

	[Test]
	public async Task A_project_identity_that_is_a_direct_selector_keeps_the_parent_inside_that_project()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var workspace = await Workspaces.WorkspaceInitializer.InitializeAsync(runtime, Tenant, "my-repo");
		var outside = await CreateAsync(runtime, Entity("initiative", "Outside"));

		var failure = await ExpectFailureAsync(() => CreateAsync(runtime, Entity("issue", "Inside?", outside.Id), identity: workspace.Project.Reference));

		await Assert.That(failure.Message).IsEqualTo($"Entity not found: {outside.Id}");
	}

	[Test]
	public async Task A_tenant_cannot_read_or_list_the_entities_of_another_tenant()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var created = await CreateAsync(runtime, Entity("initiative", "Tenant A initiative"));

		var otherList = await EntityStore.ListAsync(runtime, "tenant-b", null, "initiative");
		var failure = await ExpectFailureAsync(() => EntityStore.GetDetailsAsync(runtime, "tenant-b", null, created.Id));
		var ownList = await EntityStore.ListAsync(runtime, Tenant, null, "initiative");

		await Assert.That(otherList).IsEmpty();
		await Assert.That(failure.Message).IsEqualTo($"Entity not found: {created.Id}");
		await Assert.That(ownList.Select(entity => entity.Id)).IsEquivalentTo([created.Id]);
	}

	[Test]
	public async Task A_list_is_ordered_by_id_carries_derived_statuses_and_knows_only_real_kinds()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));
		var created = new List<EntitySummary>();
		for (var index = 0; index < 4; index++)
		{
			created.Add(await CreateAsync(runtime, new CreateEntityRequest { Kind = "issue", Title = $"Issue {index}", ParentId = initiative.Id, Status = index == 0 ? "in-progress" : null }));
		}

		var issues = await EntityStore.ListAsync(runtime, Tenant, null, "issue");
		var initiatives = await EntityStore.ListAsync(runtime, Tenant, null, "initiative");
		var none = await EntityStore.ListAsync(runtime, Tenant, null, "prd");
		var failure = await ExpectFailureAsync(() => EntityStore.ListAsync(runtime, Tenant, null, "bogus"));

		await Assert.That(issues.Select(entity => entity.Id)).IsEquivalentTo(created.Select(entity => entity.Id).Order(StringComparer.Ordinal));
		await Assert.That(initiatives.Single().Status).IsEqualTo("active");
		await Assert.That(none).IsEmpty();
		await Assert.That(failure.Message).IsEqualTo("Unknown entity kind: bogus");
	}

	[Test]
	public async Task A_query_filters_by_derived_status_and_parent_and_reports_the_total_before_the_limit()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var first = await CreateAsync(runtime, Entity("initiative", "First"));
		var second = await CreateAsync(runtime, Entity("initiative", "Second"));
		var started = await CreateAsync(runtime, new CreateEntityRequest { Kind = "issue", Title = "Started", ParentId = first.Id, Status = "in-progress" });
		var todoOne = await CreateAsync(runtime, Entity("issue", "Todo one", first.Id));
		var todoTwo = await CreateAsync(runtime, Entity("issue", "Todo two", first.Id));
		var elsewhere = await CreateAsync(runtime, Entity("issue", "Elsewhere", second.Id));

		var inProgress = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "issue", Statuses = ["in-progress"] });
		var underFirst = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "issue", ParentId = first.Reference });
		var limited = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "issue", ParentId = first.ShortReference, Statuses = ["todo"], Limit = 1 });
		var activeInitiatives = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "initiative", Statuses = ["active"] });
		var draftInitiatives = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "initiative", Statuses = ["draft"] });

		await Assert.That(inProgress.Entities.Select(entity => entity.Id)).IsEquivalentTo([started.Id]);
		await Assert.That(inProgress.Total).IsEqualTo(1);
		await Assert.That(underFirst.Entities.Select(entity => entity.Id)).IsEquivalentTo([started.Id, todoOne.Id, todoTwo.Id]);
		await Assert.That(underFirst.Total).IsEqualTo(3);
		await Assert.That(limited.Entities).HasSingleItem();
		await Assert.That(limited.Total).IsEqualTo(2);
		await Assert.That(activeInitiatives.Entities.Select(entity => entity.Id)).IsEquivalentTo([first.Id]);
		await Assert.That(draftInitiatives.Entities.Select(entity => entity.Id)).IsEquivalentTo([second.Id]);
		await Assert.That(elsewhere.Id).IsNotEqualTo(first.Id);
		await Assert.That(activeInitiatives.OpenBlockers).IsNull();
	}

	[Test]
	public async Task A_query_with_an_unknown_parent_or_no_match_is_empty_and_issue_results_carry_open_blockers()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));
		var blocked = await CreateAsync(runtime, Entity("issue", "Blocked", initiative.Id));
		var openBlocker = await CreateAsync(runtime, Entity("issue", "Open blocker", initiative.Id));
		var closedBlocker = await CreateAsync(runtime, new CreateEntityRequest { Kind = "issue", Title = "Closed blocker", ParentId = initiative.Id, Status = "done" });
		await using var admin = database.Admin();
		foreach (var blocker in new[] { openBlocker.Id, closedBlocker.Id })
		{
			await using var command = admin.CreateCommand(
				$"INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES ('{Tenant}', '{blocker}', '{blocked.Id}', 'blocks', '2026-01-01T00:00:00.000Z')");
			await command.ExecuteNonQueryAsync();
		}

		var unknownParent = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "issue", ParentId = "missing" });
		var noMatch = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "issue", Statuses = ["deferred"] });
		var all = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "issue" });

		await Assert.That(unknownParent.Entities).IsEmpty();
		await Assert.That(unknownParent.OpenBlockers).IsEmpty();
		await Assert.That(noMatch.Total).IsEqualTo(0);
		await Assert.That(noMatch.OpenBlockers).IsEmpty();
		await Assert.That(all.OpenBlockers![blocked.Reference]).IsEquivalentTo([openBlocker.Reference]);
		await Assert.That(all.OpenBlockers[openBlocker.Reference]).IsEmpty();
		await Assert.That(all.OpenBlockers[closedBlocker.Reference]).IsEmpty();
	}

	[Test]
	public async Task A_query_for_an_unknown_kind_fails()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var failure = await ExpectFailureAsync(() => EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "bogus" }));

		await Assert.That(failure.Message).IsEqualTo("Unknown entity kind: bogus");
	}

	[Test]
	public async Task A_tombstoned_entity_is_not_found_listed_queried_or_used_as_a_parent()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));
		var issue = await CreateAsync(runtime, Entity("issue", "Gone", initiative.Id));
		await using (var admin = database.Admin())
		{
			await using var command = admin.CreateCommand($"UPDATE entities SET tombstone = true WHERE id = '{issue.Id}'");
			await command.ExecuteNonQueryAsync();
		}

		var details = await ExpectFailureAsync(() => EntityStore.GetDetailsAsync(runtime, Tenant, null, issue.Id));
		var asParent = await ExpectFailureAsync(() => CreateAsync(runtime, Entity("issue", "Child", issue.Id)));
		var listed = await EntityStore.ListAsync(runtime, Tenant, null, "issue");
		var queried = await EntityStore.QueryAsync(runtime, Tenant, null, new QueryEntitiesRequest { Kind = "issue" });
		var initiativeDetails = await EntityStore.GetDetailsAsync(runtime, Tenant, null, initiative.Id);

		await Assert.That(details.Message).IsEqualTo($"Entity not found: {issue.Id}");
		await Assert.That(asParent.Message).IsEqualTo($"Entity not found: {issue.Id}");
		await Assert.That(listed).IsEmpty();
		await Assert.That(queried.Total).IsEqualTo(0);
		await Assert.That(initiativeDetails.Outgoing).IsEmpty();
	}

	[Test]
	public async Task Parallel_creates_in_one_tenant_all_succeed_with_distinct_short_references()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));

		var created = await Task.WhenAll(Enumerable.Range(0, 24).Select(index => CreateAsync(runtime, Entity("issue", $"Parallel {index}", initiative.Id))));

		await Assert.That(created.Select(entity => entity.ShortReference).Distinct().Count()).IsEqualTo(24);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities WHERE kind = 'issue'")).IsEqualTo(24L);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM revision_entries WHERE record_kind = 'entity'")).IsEqualTo(25L);
	}

	[Test]
	public async Task An_entity_created_under_a_parent_of_another_project_joins_the_project_of_the_parent()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var inDefault = await CreateAsync(runtime, Entity("initiative", "Default initiative"));

		var child = await CreateAsync(runtime, Entity("issue", "Child", inDefault.Id), identity: "my-repo");

		await Assert.That(await database.ScalarAsync<long>($"SELECT count(*) FROM entities WHERE id = '{child.Id}' AND project_id = '{DefaultWorkspace.Project.StableId}'")).IsEqualTo(1L);
	}

	[Test]
	public async Task An_initiative_bundle_holds_what_the_initiative_reaches_with_the_links_between_them()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var initiative = await CreateAsync(runtime, Entity("initiative", "Initiative"));
		var prd = await CreateAsync(runtime, Entity("prd", "PRD", initiative.Id));
		var story = await CreateAsync(runtime, Entity("userStory", "Story", prd.Id));
		var adr = await CreateAsync(runtime, Entity("adr", "ADR", initiative.Id));
		var issue = await CreateAsync(runtime, Entity("issue", "Issue", initiative.Id));
		var sub = await CreateAsync(runtime, new CreateEntityRequest { Kind = "issue", Title = "Sub", ParentId = issue.Id, Status = "done" });
		var other = await CreateAsync(runtime, Entity("initiative", "Other initiative"));
		var unrelated = await CreateAsync(runtime, Entity("issue", "Unrelated", other.Id));
		await using (var admin = database.Admin())
		{
			foreach (var (from, to, type) in new[] { (issue.Id, story.Id, "fixes"), (sub.Id, issue.Id, "blocks"), (adr.Id, issue.Id, "constrains") })
			{
				await using var command = admin.CreateCommand(
					$"INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES ('{Tenant}', '{from}', '{to}', '{type}', '2026-01-01T00:00:00.000Z')");
				await command.ExecuteNonQueryAsync();
			}
		}

		var bundle = await EntityStore.GetInitiativeBundleAsync(runtime, Tenant, null, initiative.Reference);

		await Assert.That(bundle.Initiative.Id).IsEqualTo(initiative.Id);
		await Assert.That(bundle.Initiative.Status).IsEqualTo("active");
		await Assert.That(bundle.Initiative.Body).IsEmpty();
		await Assert.That(bundle.Entities.Select(entity => entity.Id)).IsEquivalentTo(
			new[] { initiative.Id, prd.Id, story.Id, adr.Id, issue.Id, sub.Id }.Order(StringComparer.Ordinal));
		await Assert.That(bundle.Prds.Select(entity => entity.Id)).IsEquivalentTo([prd.Id]);
		await Assert.That(bundle.UserStories.Select(entity => (entity.Id, entity.Status))).IsEquivalentTo([(story.Id, "in-progress")]);
		await Assert.That(bundle.Adrs.Select(entity => entity.Id)).IsEquivalentTo([adr.Id]);
		await Assert.That(bundle.Issues.Select(entity => entity.Id)).IsEquivalentTo(new[] { issue.Id, sub.Id }.Order(StringComparer.Ordinal));
		await Assert.That(bundle.FixLinks.Select(link => (link.Issue.Id, link.UserStory.Id))).IsEquivalentTo([(issue.Id, story.Id)]);
		await Assert.That(bundle.SubIssueLinks.Select(link => (link.Parent.Id, link.Issue.Id))).IsEquivalentTo([(issue.Id, sub.Id)]);
		await Assert.That(bundle.BlockerLinks.Select(link => (link.Source.Id, link.Target.Id))).IsEquivalentTo([(sub.Id, issue.Id)]);
		await Assert.That(bundle.ConstrainsLinks.Select(link => (link.Adr.Id, link.Issue.Id))).IsEquivalentTo([(adr.Id, issue.Id)]);
		await Assert.That(bundle.VersionCoverage).IsEmpty();
		await Assert.That(bundle.Entities.Select(entity => entity.Id)).DoesNotContain(unrelated.Id);
	}

	[Test]
	public async Task An_initiative_bundle_of_something_else_or_of_nothing_fails()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var project = await CreateAsync(runtime, Entity("project", "Project"));

		var notInitiative = await ExpectFailureAsync(() => EntityStore.GetInitiativeBundleAsync(runtime, Tenant, null, project.Id));
		var missing = await ExpectFailureAsync(() => EntityStore.GetInitiativeBundleAsync(runtime, Tenant, null, "missing"));

		await Assert.That(notInitiative.Message).IsEqualTo($"{project.Id} is not an initiative.");
		await Assert.That(missing.Message).IsEqualTo("Entity not found: missing");
	}
}
