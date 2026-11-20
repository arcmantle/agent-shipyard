using AgentLogbook.Core.ContentHashes;
using AgentLogbook.Core.Identity;
using AgentLogbook.Core.Workspaces;
using AgentLogbook.Storage.Postgres.Workspaces;
using Npgsql;

namespace AgentLogbook.Storage.Postgres.Tests;

public class WorkspaceInitializerTests
{
	private static async Task<(TestDatabase Database, NpgsqlDataSource Runtime)> NewDatabaseAsync()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		return (database, database.Runtime());
	}

	[Test]
	public async Task Without_an_identity_the_default_project_and_epic_get_the_derived_identities()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var first = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", null);
		var again = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", "  ");

		await Assert.That(first.Project.Id).IsEqualTo(DefaultWorkspace.Project.StableId);
		await Assert.That(first.Project.Reference).IsEqualTo(DefaultWorkspace.Project.Reference);
		await Assert.That(first.Project.Title).IsEqualTo("Default Project");
		await Assert.That(first.Epic.Id).IsEqualTo(DefaultWorkspace.Epic.StableId);
		await Assert.That(first.Epic.Title).IsEqualTo("Default Epic");
		await Assert.That(first.DefaultProject).IsEqualTo(first.Project);
		await Assert.That(first.DefaultEpic).IsEqualTo(first.Epic);
		await Assert.That(first.TenantId).IsEqualTo("tenant-a");
		await Assert.That(first.Created).IsTrue();
		await Assert.That(again.Created).IsFalse();
		await Assert.That(again.Project).IsEqualTo(first.Project);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities")).IsEqualTo(2L);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM relations WHERE type = 'contains'")).IsEqualTo(1L);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM counters")).IsEqualTo(11L);
	}

	[Test]
	public async Task The_default_rows_keep_literal_hashes_and_wire_nulls()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", null);

		await Assert.That(await database.ScalarAsync<string>("SELECT content_hash FROM entities WHERE kind = 'project'"))
			.IsEqualTo(ContentHash.ForEntity("Default Project", ""));
		await Assert.That(await database.ScalarAsync<string>("SELECT content_hash FROM entities WHERE kind = 'epic'"))
			.IsEqualTo(ContentHash.ForEntity("Default Epic", ""));
		await Assert.That(await database.ScalarAsync<long>(
			"SELECT count(*) FROM entities WHERE created_by IS NULL AND updated_by IS NULL AND category IS NULL AND priority IS NULL AND type IS NULL AND body = '' AND body_source = 'generated' AND status = 'active' AND revision = 1 AND tombstone = false"))
			.IsEqualTo(2L);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities WHERE project_id = id AND kind = 'project'")).IsEqualTo(1L);
		await Assert.That(await database.ScalarAsync<string>("SELECT short_reference FROM entities WHERE kind = 'project'"))
			.IsEqualTo(CanonicalReference.ShortReference(DefaultWorkspace.Project.StableId, "project"));
	}

	[Test]
	public async Task An_identity_registers_its_own_project_with_an_epic_once()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var first = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", "my-repo");
		var again = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", " my-repo ");

		await Assert.That(first.Created).IsTrue();
		await Assert.That(first.Project.Title).IsEqualTo("my-repo");
		await Assert.That(first.Project.Id).IsNotEqualTo(DefaultWorkspace.Project.StableId);
		await Assert.That(first.Epic.Title).IsEqualTo("Default Epic");
		await Assert.That(first.Epic.Id).IsNotEqualTo(DefaultWorkspace.Epic.StableId);
		await Assert.That(CanonicalReference.Decode(first.Project.Reference).StableId).IsEqualTo(first.Project.Id);
		await Assert.That(CanonicalReference.Decode(first.Epic.Reference).Kind).IsEqualTo(ReferenceKind.Epic);
		await Assert.That(first.DefaultProject.Id).IsEqualTo(DefaultWorkspace.Project.StableId);
		await Assert.That(again.Created).IsFalse();
		await Assert.That(again.Project).IsEqualTo(first.Project);
		await Assert.That(again.Epic).IsEqualTo(first.Epic);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities WHERE kind = 'project'")).IsEqualTo(2L);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities WHERE kind = 'epic'")).IsEqualTo(2L);
		await Assert.That(await database.ScalarAsync<long>(
			$"SELECT count(*) FROM relations WHERE type = 'contains' AND from_id = '{first.Project.Id}' AND to_id = '{first.Epic.Id}'")).IsEqualTo(1L);
		await Assert.That(await database.ScalarAsync<long>($"SELECT count(*) FROM entities WHERE project_id = '{first.Project.Id}'")).IsEqualTo(2L);
	}

	[Test]
	public async Task An_identity_matches_a_project_by_its_stable_id_reference_or_normalized_title()
	{
		var (_, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var created = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", "My Project");

		var byId = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", created.Project.Id);
		var byReference = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", created.Project.Reference);
		var byTitle = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", "my-project");

		await Assert.That(byId.Project.Id).IsEqualTo(created.Project.Id);
		await Assert.That(byReference.Project.Id).IsEqualTo(created.Project.Id);
		await Assert.That(byTitle.Project.Id).IsEqualTo(created.Project.Id);
		await Assert.That(byId.Created || byReference.Created || byTitle.Created).IsFalse();
		await Assert.That(byTitle.Epic).IsEqualTo(created.Epic);
	}

	[Test]
	public async Task A_direct_selector_that_names_nothing_is_an_error_and_registers_nothing()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		var unknownId = "11111111-1111-4111-8111-111111111111";

		var error = await Assert.That(async () => await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", unknownId))
			.Throws<WorkspaceException>();

		await Assert.That(error!.Message).IsEqualTo($"Cannot resolve project identity \"{unknownId}\" in tenant tenant-a.");
		// The failed call rolls back, including the default workspace that it started to seed.
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities")).IsEqualTo(0L);
	}

	[Test]
	public async Task Two_projects_with_one_normalized_title_make_the_identity_ambiguous()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;
		await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", "Repo One");
		await database.ExecuteAsync(
			"""
			INSERT INTO entities (tenant_id, id, reference, short_reference, kind, title, status, created_at, updated_at, project_id)
			VALUES ('tenant-a', '22222222-2222-4222-8222-222222222222', 'PROJ_TWO', 'PROJ_TWO', 'project', 'repo--one', 'active', 'x', 'x', '22222222-2222-4222-8222-222222222222')
			""");

		var error = await Assert.That(async () => await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", "repo one"))
			.Throws<WorkspaceException>();

		await Assert.That(error!.Message).IsEqualTo("Ambiguous project identity \"repo one\" in tenant tenant-a.");
	}

	[Test]
	public async Task Concurrent_first_calls_for_one_identity_register_one_project()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", "busy-repo")));

		await Assert.That(results.Select(result => result.Project.Id).Distinct().Count()).IsEqualTo(1);
		await Assert.That(results.Count(result => result.Created)).IsEqualTo(1);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities WHERE title = 'busy-repo'")).IsEqualTo(1L);
	}

	[Test]
	public async Task Each_tenant_gets_its_own_workspace_and_counters()
	{
		var (database, runtime) = await NewDatabaseAsync();
		await using var _ = runtime;

		var first = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-a", "shared-name");
		var second = await WorkspaceInitializer.InitializeAsync(runtime, "tenant-b", "shared-name");

		await Assert.That(second.Project.Id).IsNotEqualTo(first.Project.Id);
		await Assert.That(second.Created).IsTrue();
		await Assert.That(second.DefaultProject.Id).IsEqualTo(first.DefaultProject.Id);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities WHERE tenant_id = 'tenant-a'")).IsEqualTo(4L);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM entities WHERE tenant_id = 'tenant-b'")).IsEqualTo(4L);
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM counters WHERE tenant_id = 'tenant-b'")).IsEqualTo(11L);
	}
}
