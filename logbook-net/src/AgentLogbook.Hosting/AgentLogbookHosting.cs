using System.Reflection;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.JavaScript;

namespace AgentLogbook.Hosting;

/// <summary>Settings of <see cref="AgentLogbookHosting.AddAgentLogbook"/>. Every value has a default for the standalone AppHost.</summary>
public sealed class AgentLogbookOptions
{
	/// <summary>The root of <c>logbook-net</c>. The default is the folder that this library was built from.</summary>
	public string? LogbookNetRoot { get; init; }

	/// <summary>
	/// The Shipyard data folder of the Development API host (<c>AGENT_SHIPYARD_HOME</c>).
	/// The default is <c>.agent-shipyard</c> in <see cref="LogbookNetRoot"/>, never the user folder.
	/// </summary>
	public string? ShipyardHome { get; init; }
}

/// <summary>The resources that <see cref="AgentLogbookHosting.AddAgentLogbook"/> added.</summary>
public sealed record AgentLogbookResources(
	IResourceBuilder<PostgresServerResource> Postgres,
	IResourceBuilder<PostgresDatabaseResource> Database,
	IResourceBuilder<ProjectResource> Api,
	IResourceBuilder<ViteAppResource> Site,
	IResourceBuilder<ViteAppResource> Kanban,
	string ShipyardHome);

/// <summary>
/// The one Aspire composition of Logbook. The standalone AppHost and a later Helm AppHost both call it. It adds resources to the
/// builder it is given and never starts another AppHost.
/// </summary>
public static class AgentLogbookHosting
{
	public const string PostgresName = "logbook-postgres";
	public const string DatabaseName = "logbook";
	public const string ApiName = "logbook-api";
	public const string ApiEndpointName = "http";
	public const string SiteName = "logbook-site";
	public const string KanbanName = "logbook-kanban";

	/// <summary>The process-local override that routes a CLI process to the Development API host. It matches the client's variable.</summary>
	public const string ApiUrlVariable = "AGENT_LOGBOOK_API_URL";

	/// <summary>
	/// The PostgreSQL image of the Aspire server. It is the major version of <c>docker/compose.yaml</c> and of the storage tests: the schema
	/// signature that the API checks at startup depends on the major version, so a newer default image would be refused.
	/// </summary>
	public const string PostgresImageTag = "16-alpine";

	private const string ShipyardHomeVariable = "AGENT_SHIPYARD_HOME";
	private const string PortVariable = "AGENT_LOGBOOK_DEV_API_PORT";
	private const string WebFolder = "web";
	private const string DevelopmentApiProject = "src/AgentLogbook.DevelopmentApi/AgentLogbook.DevelopmentApi.csproj";

	/// <summary>
	/// Adds the PostgreSQL server of Aspire, one database, the Development API host, and the copied site and Kanban Vite clients
	/// (pnpm workspace <c>web</c>). Each client gets the Development API host URL for its proxy. The host keeps its files in the
	/// repository-local Shipyard folder, so it does not read or change the user Local API discovery file, saved logins, or backend choice.
	/// </summary>
	public static AgentLogbookResources AddAgentLogbook(this IDistributedApplicationBuilder builder, AgentLogbookOptions? options = null)
	{
		ArgumentNullException.ThrowIfNull(builder);

		var root = options?.LogbookNetRoot ?? BuiltRoot();
		var shipyardHome = Path.GetFullPath(options?.ShipyardHome ?? Path.Combine(root, ".agent-shipyard"));

		var postgres = builder.AddPostgres(PostgresName).WithImageTag(PostgresImageTag);
		var database = postgres.AddDatabase(DatabaseName);

		var api = builder.AddProject(ApiName, Path.Combine(root, DevelopmentApiProject))
			.WithHttpEndpoint(name: ApiEndpointName, env: PortVariable)
			// The host binds its port only after the schema is ready, so "healthy" means it accepts requests.
			.WithHttpHealthCheck("/health/ready", endpointName: ApiEndpointName)
			.WithEnvironment(ShipyardHomeVariable, shipyardHome)
			.WithReference(database)
			.WaitFor(database);

		var site = AddWebClient(builder, root, SiteName, "site", api);
		var kanban = AddWebClient(builder, root, KanbanName, "kanban", api);

		return new AgentLogbookResources(postgres, database, api, site, kanban, shipyardHome);
	}

	// Each client is its own resource, so it has its own origin and its own browser state. Aspire gives the port, so two clients never collide.
	private static IResourceBuilder<ViteAppResource> AddWebClient(IDistributedApplicationBuilder builder, string root, string name, string folder, IResourceBuilder<ProjectResource> api) =>
		builder.AddViteApp(name, Path.Combine(root, WebFolder, folder))
			.WithPnpm()
			.WithAgentLogbookApi(api);

	/// <summary>
	/// Gives <paramref name="consumer"/> the Development API host URL in <c>AGENT_LOGBOOK_API_URL</c>. Use it for a development CLI
	/// process. The variable lives in that process only; nothing is saved.
	/// </summary>
	public static IResourceBuilder<T> WithAgentLogbookApi<T>(this IResourceBuilder<T> consumer, AgentLogbookResources logbook)
		where T : IResourceWithEnvironment, IResourceWithWaitSupport
	{
		ArgumentNullException.ThrowIfNull(logbook);

		return consumer.WithAgentLogbookApi(logbook.Api);
	}

	private static IResourceBuilder<T> WithAgentLogbookApi<T>(this IResourceBuilder<T> consumer, IResourceBuilder<ProjectResource> api)
		where T : IResourceWithEnvironment, IResourceWithWaitSupport
	{
		ArgumentNullException.ThrowIfNull(consumer);

		return consumer
			.WithEnvironment(ApiUrlVariable, api.GetEndpoint(ApiEndpointName))
			.WaitFor(api);
	}

	private static string BuiltRoot() =>
		typeof(AgentLogbookHosting).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
			.FirstOrDefault(item => item.Key == "LogbookNetRoot")?.Value
		?? throw new InvalidOperationException("This library was built without its logbook-net root. Pass AgentLogbookOptions.LogbookNetRoot.");
}
