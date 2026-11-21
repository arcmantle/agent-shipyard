using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace AgentLogbook.Api;

/// <summary>
/// The local control path of the Local API host. <c>GET /local/host</c> says which process answers, so a client can prove that it talks to
/// the host that the discovery file names. <c>POST /local/host/stop</c> asks the host to stop: it answers 202, and the process then lets the
/// active requests finish and ends. <see cref="ApiHost"/> maps both only for <see cref="Auth.LocalNoAuthProvider"/> with a stop handler.
/// </summary>
internal static class LocalHostControl
{
	public const string IdentityPath = "/local/host";
	public const string StopPath = "/local/host/stop";

	public static void Map(IEndpointRouteBuilder endpoints, string toolVersion, Action requestStop)
	{
		endpoints.MapGet(IdentityPath, () => Results.Json(new { processId = Environment.ProcessId, toolVersion }));

		// Func<..., IResult> keeps the route on the IResult overload; a bare lambda would bind to RequestDelegate and drop the result.
		Func<HttpContext, IResult> stop = context =>
		{
			// A browser page can send a simple POST to a loopback address, and DNS rebinding changes the Host. Requiring JSON forces a
			// preflight that the host never allows, and only loopback host names are accepted.
			if (!context.Request.HasJsonContentType())
			{
				return Results.Json(new { error = "The request content type must be application/json." }, statusCode: StatusCodes.Status415UnsupportedMediaType);
			}

			if (!IsLoopbackHost(context.Request.Host.Host))
			{
				return Results.Json(new { error = "The control path accepts loopback host names only." }, statusCode: StatusCodes.Status403Forbidden);
			}

			// The stop starts after the answer is sent, so the caller always gets the 202. It runs on another thread: the owner of the host
			// then stops the API while this request is still ending, and a stop that waited for this request would wait for itself.
			context.Response.OnCompleted(() =>
			{
				_ = Task.Run(requestStop);
				return Task.CompletedTask;
			});
			return Results.Json(new { status = "stopping", processId = Environment.ProcessId }, statusCode: StatusCodes.Status202Accepted);
		};
		endpoints.MapPost(StopPath, stop);
	}

	private static bool IsLoopbackHost(string host) =>
		host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
		|| (System.Net.IPAddress.TryParse(host.Trim('[', ']'), out var address) && System.Net.IPAddress.IsLoopback(address));
}
