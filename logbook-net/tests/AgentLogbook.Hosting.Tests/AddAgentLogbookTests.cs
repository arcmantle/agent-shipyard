using AgentLogbook.Client;
using AgentLogbook.Hosting;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Postgres;
using Microsoft.Extensions.Logging.Abstractions;

namespace AgentLogbook.Hosting.Tests;

/// <summary>
/// The resource graph that <see cref="AgentLogbookHosting.AddAgentLogbook"/> builds. The builder is never started, so no container or process runs.
/// This test project is a consumer like the later Helm AppHost: it references the shared library and not the standalone AppHost.
/// </summary>
public class AddAgentLogbookTests
{
	private static IDistributedApplicationBuilder NewBuilder() => DistributedApplication.CreateBuilder(new DistributedApplicationOptions { Args = [] });

	private static async Task<Dictionary<string, string>> EnvironmentOf(IResourceWithEnvironment resource)
	{
		var configuration = await ExecutionConfigurationBuilder.Create(resource)
			.WithEnvironmentVariablesConfig()
			.BuildAsync(
				new DistributedApplicationExecutionContext(DistributedApplicationOperation.Publish),
				NullLogger.Instance,
				CancellationToken.None);

		return configuration.EnvironmentVariables.ToDictionary(item => item.Key, item => item.Value);
	}

	[Test]
	public async Task Adds_postgres_one_database_and_the_api_in_one_composition()
	{
		var builder = NewBuilder();

		var logbook = builder.AddAgentLogbook();

		// Aspire also adds the generated password parameter of the server, so the composition is checked by resource type, not by the whole list.
		await Assert.That(builder.Resources.OfType<ProjectResource>().Select(resource => resource.Name).ToArray()).IsEquivalentTo(["logbook-api"]);
		await Assert.That(builder.Resources.OfType<PostgresServerResource>().Select(resource => resource.Name).ToArray()).IsEquivalentTo(["logbook-postgres"]);
		await Assert.That(builder.Resources.OfType<PostgresDatabaseResource>().Select(resource => resource.Name).ToArray()).IsEquivalentTo(["logbook"]);
		await Assert.That(builder.Resources.OfType<ContainerResource>().Count()).IsEqualTo(1);
		await Assert.That(logbook.Postgres.Resource).IsTypeOf<PostgresServerResource>();
		await Assert.That(logbook.Database.Resource.Parent).IsEqualTo(logbook.Postgres.Resource);
		await Assert.That(logbook.Api.Resource.TryGetAnnotationsOfType<WaitAnnotation>(out var waits)).IsTrue();
		await Assert.That(waits!.Any(wait => wait.Resource == logbook.Database.Resource)).IsTrue();
	}

	[Test]
	public async Task The_postgres_image_is_the_major_version_of_the_compose_file()
	{
		var builder = NewBuilder();

		var logbook = builder.AddAgentLogbook();
		var image = logbook.Postgres.Resource.Annotations.OfType<ContainerImageAnnotation>().Single();

		var compose = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "../../../../../docker/compose.yaml"));
		await Assert.That(compose).Contains($"image: postgres:{image.Tag}");
	}

	[Test]
	public async Task The_api_keeps_its_state_in_the_repository_local_shipyard_folder_and_gets_the_database()
	{
		var builder = NewBuilder();

		var logbook = builder.AddAgentLogbook();
		var environment = await EnvironmentOf(logbook.Api.Resource);

		var logbookNet = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../.."));
		await Assert.That(File.Exists(Path.Combine(logbookNet, "AgentLogbook.slnx"))).IsTrue();
		await Assert.That(environment["AGENT_SHIPYARD_HOME"]).IsEqualTo(Path.Combine(logbookNet, ".agent-shipyard"));
		await Assert.That(environment["AGENT_SHIPYARD_HOME"]).IsNotEqualTo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agent-shipyard"));
		await Assert.That(environment.ContainsKey("ConnectionStrings__logbook")).IsTrue();
		await Assert.That(environment.ContainsKey("AGENT_LOGBOOK_DEV_API_PORT")).IsTrue();
	}

	[Test]
	public async Task The_api_does_not_route_itself_so_the_user_state_cannot_be_redirected()
	{
		var builder = NewBuilder();

		var logbook = builder.AddAgentLogbook();
		var environment = await EnvironmentOf(logbook.Api.Resource);

		await Assert.That(environment.ContainsKey(BackendRouter.ApiUrlVariable)).IsFalse();
		await Assert.That(AgentLogbookHosting.ApiUrlVariable).IsEqualTo(BackendRouter.ApiUrlVariable);
	}

	[Test]
	public async Task A_consumer_gets_the_api_url_in_its_own_process_environment_only()
	{
		var builder = NewBuilder();
		var logbook = builder.AddAgentLogbook();

		var cli = builder.AddExecutable("cli", "agent-logbook", ".").WithAgentLogbookApi(logbook);
		var environment = await EnvironmentOf(cli.Resource);

		await Assert.That(environment[BackendRouter.ApiUrlVariable]).IsEqualTo("{logbook-api.bindings.http.url}");
		await Assert.That(environment.ContainsKey("AGENT_SHIPYARD_HOME")).IsFalse();
		await Assert.That(cli.Resource.TryGetAnnotationsOfType<WaitAnnotation>(out var waits)).IsTrue();
		await Assert.That(waits!.Any(wait => wait.Resource == logbook.Api.Resource)).IsTrue();
	}

	[Test]
	public async Task The_state_folder_and_root_can_be_set_by_a_consumer()
	{
		var builder = NewBuilder();
		var root = Directory.CreateTempSubdirectory("logbook-net-root").FullName;
		var home = Path.Combine(root, "state");
		var project = Path.Combine(root, "src", "AgentLogbook.DevelopmentApi", "AgentLogbook.DevelopmentApi.csproj");
		Directory.CreateDirectory(Path.GetDirectoryName(project)!);
		await File.WriteAllTextAsync(project, "<Project />");

		var logbook = builder.AddAgentLogbook(new AgentLogbookOptions { LogbookNetRoot = root, ShipyardHome = home });

		await Assert.That(logbook.ShipyardHome).IsEqualTo(home);
		await Assert.That((await EnvironmentOf(logbook.Api.Resource))["AGENT_SHIPYARD_HOME"]).IsEqualTo(home);
		Directory.Delete(root, recursive: true);
	}
}
