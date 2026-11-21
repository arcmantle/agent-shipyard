using System.Net;
using AgentLogbook.Api.Rpc;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Api.Auth;
using AgentLogbook.Storage.Postgres;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace AgentLogbook.Api;

/// <summary>The shared API host. The production host and the Local API host both start it.</summary>
public static class ApiHost
{
	public const string DiscoveryPath = "/.well-known/agent-logbook";
	public const string LivePath = "/health/live";
	public const string ReadyPath = "/health/ready";

	private static readonly TimeSpan ReadinessTimeout = TimeSpan.FromSeconds(5);

	/// <summary>
	/// Starts the API on the configured address and returns when it accepts requests. The host reads no URL setting
	/// from the environment or from files, so only <see cref="ApiHostOptions"/> decides where it listens.
	/// </summary>
	public static async Task<RunningApiHost> StartAsync(ApiHostOptions options, CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(options);
		options.Validate();

		var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());
		builder.WebHost.UseKestrelCore().UseSockets().ConfigureKestrel(kestrel =>
		{
			kestrel.AddServerHeader = false;
			kestrel.Limits.MaxRequestBodySize = RpcEndpoint.MaxBodyBytes;
			kestrel.Listen(options.ListenAddress, options.ListenPort);
		});
		builder.Services.AddRoutingCore();
		builder.Logging.AddConsole();
		builder.Logging.SetMinimumLevel(LogLevel.Warning);

		var app = builder.Build();
		MapEndpoints(app, options);

		try
		{
			await app.StartAsync(cancellationToken);
			var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
			return new RunningApiHost(app, new Uri(address));
		}
		catch
		{
			await app.DisposeAsync();
			throw;
		}
	}

	private static void MapEndpoints(IEndpointRouteBuilder endpoints, ApiHostOptions options)
	{
		endpoints.MapGet(DiscoveryPath, () => Results.Json(
			new { auth = options.AuthProvider.Metadata, version = options.ToolVersion },
			statusCode: StatusCodes.Status200OK));

		var registry = options.Rpc ?? RpcMethodRegistry.CreateDefault();
		endpoints.MapPost(RpcWire.Path, (HttpContext context, ILoggerFactory loggers) =>
			RpcEndpoint.HandleAsync(context, options.AuthProvider, options.DataSource, registry, loggers.CreateLogger("AgentLogbook.Api.Rpc")));

		// Only the explicit local no-auth provider gets the direct query endpoint. A deployment has no such route,
		// whatever role a user has, because the route does not exist.
		if (options.AuthProvider is LocalNoAuthProvider)
		{
			DirectQuery.Map(endpoints, options.DataSource);
		}

		if (options.AuthProvider is LocalNoAuthProvider && options.OnStopRequested is { } requestStop)
		{
			LocalHostControl.Map(endpoints, options.ToolVersion, requestStop);
		}

		endpoints.MapGet(LivePath, () => Results.Json(new { status = "live" }));

		endpoints.MapGet(ReadyPath, async (HttpContext context) =>
		{
			context.Response.Headers.CacheControl = "no-store";
			try
			{
				using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
				timeout.CancelAfter(ReadinessTimeout);
				await using var command = options.DataSource.CreateCommand("SELECT 1");
				await command.ExecuteScalarAsync(timeout.Token);
				return Results.Json(new { status = "ready" });
			}
			catch (Exception exception) when (exception is not OperationCanceledException || !context.RequestAborted.IsCancellationRequested)
			{
				return Results.Json(new { status = "not-ready" }, statusCode: StatusCodes.Status503ServiceUnavailable);
			}
		});
	}
}

/// <summary>A started API host.</summary>
public sealed class RunningApiHost(WebApplication app, Uri url) : IAsyncDisposable
{
	public Uri Url { get; } = url;

	public int Port => Url.Port;

	/// <summary>Stops accepting requests and waits for the active requests to finish.</summary>
	public Task StopAsync(CancellationToken cancellationToken = default) => app.StopAsync(cancellationToken);

	public ValueTask DisposeAsync() => app.DisposeAsync();
}
