using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Client;

/// <summary>Why a request goes to a backend.</summary>
public enum BackendRouteSource
{
	/// <summary>The built-in <c>local login</c>: the foreground Local API host from the user discovery file.</summary>
	LocalLogin,

	/// <summary><c>AGENT_LOGBOOK_API_URL</c> overrides the active backend for this process only.</summary>
	ProcessOverride,
}

/// <summary>Where one process sends its storage requests and the token it sends, if any.</summary>
public sealed record BackendRoute(Uri BaseUrl, string? BearerToken, BackendRouteSource Source);

/// <summary>
/// Chooses the backend of the process. It only reads: it never writes the saved login selection, the credentials, or the
/// user discovery file, so an override cannot change what the next process uses.
/// </summary>
public static class BackendRouter
{
	/// <summary>The process-local override of the backend URL. The Aspire AppHost sets it for development runs.</summary>
	public const string ApiUrlVariable = "AGENT_LOGBOOK_API_URL";

	private static readonly TimeSpan LiveProbeTimeout = TimeSpan.FromSeconds(3);

	/// <summary>
	/// The override when <see cref="ApiUrlVariable"/> is set. The override reads neither the discovery file nor any saved state.
	/// Otherwise the permanent default <c>local login</c>: the discovery file must name a live process, and the host must answer
	/// its live check. The local login has no token. When <paramref name="autoStart"/> is set and no host runs, this starts one in the background
	/// and waits until it answers; it then writes the Local API log in the Logbook data folder, and nothing else.
	/// </summary>
	/// <exception cref="InvalidBackendRouteException">The override is not an absolute http or https URL.</exception>
	/// <exception cref="LocalApiUnavailableException">There is no answering Local API host.</exception>
	public static async Task<BackendRoute> ResolveAsync(
		Func<string, string?> getEnvironmentVariable,
		ShipyardLogbookFolder folder,
		HttpClient? probeClient = null,
		LocalApiLaunch? autoStart = null,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(getEnvironmentVariable);
		ArgumentNullException.ThrowIfNull(folder);

		var configured = getEnvironmentVariable(ApiUrlVariable);
		if (!string.IsNullOrWhiteSpace(configured))
		{
			return new BackendRoute(ParseOverride(configured.Trim()), null, BackendRouteSource.ProcessOverride);
		}

		var discovery = LocalApiDiscovery.Read(folder);
		if (discovery is null || !discovery.IsProcessAlive())
		{
			if (autoStart is not null)
			{
				return await LocalApiStarter.StartAsync(folder, autoStart, getEnvironmentVariable, probeClient, LocalApiStarter.DefaultStartTimeout, cancellationToken);
			}

			throw new LocalApiUnavailableException(
				$"No Local API host is running (looked in {folder.DiscoveryFile}). Start one with 'agent-logbook serve', or set {ApiUrlVariable}.");
		}

		if (!Uri.TryCreate(discovery.Url, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttp)
		{
			throw new LocalApiUnavailableException($"The discovery file {folder.DiscoveryFile} holds the invalid host URL '{discovery.Url}'.");
		}

		if (await ProbeLiveAsync(url, probeClient, cancellationToken) is { } failure)
		{
			throw failure;
		}

		return new BackendRoute(url, null, BackendRouteSource.LocalLogin);
	}

	private static Uri ParseOverride(string value)
	{
		if (!Uri.TryCreate(value, UriKind.Absolute, out var url) || url.Scheme is not ("http" or "https"))
		{
			throw new InvalidBackendRouteException($"{ApiUrlVariable} must be an absolute http or https URL, but it is '{value}'.");
		}

		return url;
	}

	/// <summary>Null when the host answers its live check. Otherwise the error that says why it does not.</summary>
	internal static async Task<LocalApiUnavailableException?> ProbeLiveAsync(Uri hostUrl, HttpClient? probeClient, CancellationToken cancellationToken)
	{
		var owned = probeClient is null;
		var client = probeClient ?? new HttpClient();
		try
		{
			using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			timeout.CancelAfter(LiveProbeTimeout);
			using var response = await client.GetAsync(new Uri(hostUrl, "/health/live"), timeout.Token);
			return response.IsSuccessStatusCode
				? null
				: new LocalApiUnavailableException($"The Local API host at {hostUrl} answered its live check with HTTP {(int)response.StatusCode}.");
		}
		catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
		{
			return new LocalApiUnavailableException(
				$"The Local API host at {hostUrl} does not answer. Stop it and start it again with 'agent-logbook serve'.", exception);
		}
		finally
		{
			if (owned)
			{
				client.Dispose();
			}
		}
	}
}
