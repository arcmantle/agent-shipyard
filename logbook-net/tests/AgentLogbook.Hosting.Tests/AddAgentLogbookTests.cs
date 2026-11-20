using AgentLogbook.Client;
using AgentLogbook.Hosting;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.JavaScript;
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

	[Test]
	public async Task Adds_the_site_and_kanban_vite_clients_from_the_web_workspace_with_pnpm()
	{
		var builder = NewBuilder();

		var logbook = builder.AddAgentLogbook();

		var logbookNet = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../.."));
		await Assert.That(builder.Resources.OfType<ViteAppResource>().Select(resource => resource.Name).Order().ToArray()).IsEquivalentTo(["logbook-kanban", "logbook-site"]);
		await Assert.That(logbook.Site.Resource.WorkingDirectory).IsEqualTo(Path.Combine(logbookNet, "web", "site"));
		await Assert.That(logbook.Kanban.Resource.WorkingDirectory).IsEqualTo(Path.Combine(logbookNet, "web", "kanban"));
		foreach (var client in new[] { logbook.Site.Resource, logbook.Kanban.Resource })
		{
			await Assert.That(Directory.Exists(client.WorkingDirectory)).IsTrue();
			await Assert.That(File.Exists(Path.Combine(client.WorkingDirectory, "vite.config.ts"))).IsTrue();
			await Assert.That(client.Annotations.OfType<JavaScriptPackageManagerAnnotation>().Last().ExecutableName).IsEqualTo("pnpm");
		}
	}

	[Test]
	public async Task Each_vite_client_gets_the_development_api_url_and_waits_for_the_api()
	{
		var builder = NewBuilder();

		var logbook = builder.AddAgentLogbook();

		foreach (var client in new[] { logbook.Site.Resource, logbook.Kanban.Resource })
		{
			var environment = await EnvironmentOf(client);
			await Assert.That(environment[BackendRouter.ApiUrlVariable]).IsEqualTo("{logbook-api.bindings.http.url}");
			await Assert.That(environment.ContainsKey("AGENT_SHIPYARD_HOME")).IsFalse();
			await Assert.That(client.TryGetAnnotationsOfType<WaitAnnotation>(out var waits)).IsTrue();
			await Assert.That(waits!.Select(wait => wait.Resource.Name)).Contains("logbook-api");
		}
	}

	[Test]
	public async Task The_clients_are_separate_resources_with_their_own_endpoints_so_their_browser_state_is_separate()
	{
		var builder = NewBuilder();

		var logbook = builder.AddAgentLogbook();

		var site = logbook.Site.Resource.Annotations.OfType<EndpointAnnotation>().Select(endpoint => endpoint.Name).ToArray();
		var kanban = logbook.Kanban.Resource.Annotations.OfType<EndpointAnnotation>().Select(endpoint => endpoint.Name).ToArray();
		await Assert.That(site).IsNotEmpty();
		await Assert.That(kanban).IsNotEmpty();
		await Assert.That(logbook.Site.Resource).IsNotEqualTo(logbook.Kanban.Resource);
	}

	[Test]
	public async Task The_web_workspace_lists_the_site_and_kanban_packages()
	{
		var web = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../web"));

		var workspace = await File.ReadAllTextAsync(Path.Combine(web, "pnpm-workspace.yaml"));

		await Assert.That(workspace).Contains("- site");
		await Assert.That(workspace).Contains("- kanban");
		await Assert.That(File.Exists(Path.Combine(web, "pnpm-lock.yaml"))).IsTrue();
	}
}
