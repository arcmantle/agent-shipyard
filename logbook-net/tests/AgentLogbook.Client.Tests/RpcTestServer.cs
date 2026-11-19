using System.Net;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AgentLogbook.Client.Tests;

/// <summary>A real HTTP server on loopback with a scripted <c>/rpc</c> answer and a live check. It records what the client sent.</summary>
internal sealed class RpcTestServer : IAsyncDisposable
{
	private readonly WebApplication app;

	private RpcTestServer(WebApplication app, Uri url)
	{
		this.app = app;
		Url = url;
	}

	public Uri Url { get; }

	public List<RecordedRequest> Requests { get; } = [];

	public Func<RecordedRequest, (int Status, string Body)> Answer { get; set; } = _ => (200, """{"jsonrpc":"2.0","id":"x","result":null}""");

	public static async Task<RpcTestServer> StartAsync()
	{
		var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());
		builder.WebHost.UseKestrelCore().UseSockets().ConfigureKestrel(kestrel => kestrel.Listen(IPAddress.Loopback, 0));
		builder.Services.AddRoutingCore();
		var app = builder.Build();
		RpcTestServer? server = null;

		((IEndpointRouteBuilder)app).MapGet("/health/live", () => Results.Json(new { status = "live" }));
		((IEndpointRouteBuilder)app).MapPost("/rpc", async (HttpContext context) =>
		{
			using var reader = new StreamReader(context.Request.Body, Encoding.UTF8);
			var recorded = new RecordedRequest(
				context.Request.Headers.ToDictionary(header => header.Key.ToLowerInvariant(), header => header.Value.ToString()),
				await reader.ReadToEndAsync());
			lock (server!.Requests)
			{
				server.Requests.Add(recorded);
			}

			var (status, body) = server.Answer(recorded);
			return Results.Text(body, "application/json", Encoding.UTF8, status);
		});

		await app.StartAsync();
		var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
		server = new RpcTestServer(app, new Uri(address));
		return server;
	}

	public ValueTask DisposeAsync() => app.DisposeAsync();
}

internal sealed record RecordedRequest(IReadOnlyDictionary<string, string> Headers, string Body);
