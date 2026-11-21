using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Client;

/// <summary>What the discovery file and the host say about the background Local API host.</summary>
public enum LocalApiHostState
{
	/// <summary>There is no discovery file. No host is running.</summary>
	Stopped,

	/// <summary>The host was asked to stop and finishes its active requests. Its file stays until the process ends.</summary>
	Stopping,

	/// <summary>The discovery file names a live process, and that process answers the local control path as itself.</summary>
	Running,

	/// <summary>
	/// The discovery file does not describe a running host. Its process has ended, or its process runs but does not answer as the host
	/// (another program that reuses the process ID, or a host that hangs), or the file cannot be read.
	/// </summary>
	Stale,
}

/// <summary>The state of the background host. <see cref="Discovery"/> is the content of the discovery file when it can be read.</summary>
/// <param name="ProcessAlive">True when the process of the discovery file is alive. Only a stale state with a live process is a state that a stop refuses.</param>
public sealed record LocalApiHostStatus(LocalApiHostState State, LocalApiDiscovery? Discovery, bool ProcessAlive, string? Reason);

/// <summary>What a stop did. <see cref="Stopped"/> is the host that ended, or null when no host was running.</summary>
public sealed record LocalApiHostStopResult(LocalApiDiscovery? Stopped, string? Note);

/// <summary>What a restart did. <see cref="Replaced"/> is the host that ended, or null when none was running.</summary>
public sealed record LocalApiHostRestartResult(LocalApiDiscovery? Replaced, LocalApiDiscovery Started);

/// <summary>A control command cannot do what it was asked to do. The message says why and what the user can do.</summary>
public sealed class LocalApiHostControlException(string message, Exception? innerException = null) : Exception(message, innerException);

/// <summary>
/// Inspects, stops and restarts the background Local API host. The discovery file names the host, and the host proves that it is the one
/// through <c>GET /local/host</c>. A stop is a request to that host, never a signal to a process ID, so a process that only reuses the ID of
/// a dead host, or any other process, is never stopped and never adopted. Inspecting never starts a host and never writes the discovery
/// file; only the host writes and removes its own file.
/// </summary>
public static class LocalApiHostControl
{
	/// <summary>How long a stop waits for the active requests to finish and the process to end.</summary>
	public static readonly TimeSpan DefaultStopTimeout = TimeSpan.FromSeconds(60);

	private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(3);
	private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(50);

	/// <summary>Reads the state without a side effect. It never starts a host.</summary>
	public static async Task<LocalApiHostStatus> InspectAsync(
		ShipyardLogbookFolder folder,
		HttpClient? client = null,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(folder);

		var discovery = LocalApiDiscovery.Read(folder);
		if (discovery is null)
		{
			return File.Exists(folder.DiscoveryFile)
				? new(LocalApiHostState.Stale, null, false, $"The discovery file {folder.DiscoveryFile} cannot be read.")
				: new(LocalApiHostState.Stopped, null, false, null);
		}

		if (!discovery.IsProcessAlive())
		{
			return new(LocalApiHostState.Stale, discovery, false, $"The discovery file names process {discovery.ProcessId}, which is not running.");
		}

		if (discovery.Stopping)
		{
			return new(LocalApiHostState.Stopping, discovery, true, $"Process {discovery.ProcessId} is finishing its active requests before it ends.");
		}

		var identity = await ReadIdentityAsync(discovery, client, cancellationToken);
		return identity == discovery.ProcessId
			? new(LocalApiHostState.Running, discovery, true, null)
			: new(
				LocalApiHostState.Stale,
				discovery,
				true,
				$"Process {discovery.ProcessId} is running, but nothing at {discovery.Url} answers as that Local API host. The process is not touched.");
	}

	/// <summary>
	/// Asks the running host to stop and waits until its process has ended. The host lets the active requests finish first.
	/// A repeated stop waits for a drain that is under way. A stop with only a stale file of an ended host, or a stop with only a stale file of an ended host, changes nothing and succeeds.
	/// </summary>
	/// <exception cref="LocalApiHostControlException">The state is stale with a live process, the host refuses, or the process does not end in time.</exception>
	public static async Task<LocalApiHostStopResult> StopAsync(
		ShipyardLogbookFolder folder,
		HttpClient? client = null,
		TimeSpan? timeout = null,
		CancellationToken cancellationToken = default)
	{
		var status = await InspectAsync(folder, client, cancellationToken);
		switch (status)
		{
			case { State: LocalApiHostState.Stopped }:
				return new(null, null);

			case { State: LocalApiHostState.Stopping }:
				// A repeated stop does not ask again. It waits for the drain that is under way.
				await WaitForEndAsync(status.Discovery!, timeout ?? DefaultStopTimeout, cancellationToken);
				return new(status.Discovery, null);

			case { State: LocalApiHostState.Stale, ProcessAlive: false }:
				return new(null, status.Reason);

			case { State: LocalApiHostState.Stale }:
				throw new LocalApiHostControlException(
					$"{status.Reason} Stop that process yourself if it is a stuck Local API host, and remove {folder.DiscoveryFile} if the host is gone.");
		}

		var discovery = status.Discovery!;
		await RequestStopAsync(discovery, client, cancellationToken);
		await WaitForEndAsync(discovery, timeout ?? DefaultStopTimeout, cancellationToken);
		return new(discovery, null);
	}

	/// <summary>
	/// Stops the running host as <see cref="StopAsync"/> does, then starts one replacement with the Local API settings of the caller.
	/// With no host running it only starts one.
	/// </summary>
	/// <exception cref="LocalApiHostControlException">The stop fails.</exception>
	/// <exception cref="LocalApiUnavailableException">The replacement does not start. The old host is gone then.</exception>
	public static async Task<LocalApiHostRestartResult> RestartAsync(
		ShipyardLogbookFolder folder,
		LocalApiLaunch launch,
		Func<string, string?> getEnvironmentVariable,
		HttpClient? client = null,
		TimeSpan? stopTimeout = null,
		TimeSpan? startTimeout = null,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(launch);
		ArgumentNullException.ThrowIfNull(getEnvironmentVariable);

		var stopped = await StopAsync(folder, client, stopTimeout, cancellationToken);
		await LocalApiStarter.StartAsync(folder, launch, getEnvironmentVariable, client, startTimeout ?? LocalApiStarter.DefaultStartTimeout, cancellationToken);

		// The route proved a live host. The file says which one it is.
		var started = LocalApiDiscovery.Read(folder)
			?? throw new LocalApiUnavailableException($"The replacement host answered, but {folder.DiscoveryFile} does not describe it.");
		return new(stopped.Stopped, started);
	}

	/// <summary>The process ID that the host at the discovery URL reports, or null when nothing there answers as a Local API host.</summary>
	private static async Task<int?> ReadIdentityAsync(LocalApiDiscovery discovery, HttpClient? client, CancellationToken cancellationToken)
	{
		if (!Uri.TryCreate(discovery.Url, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttp)
		{
			return null;
		}

		var owned = client is null;
		client ??= new HttpClient();
		try
		{
			using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			timeout.CancelAfter(RequestTimeout);
			using var response = await client.GetAsync(new Uri(url, "/local/host"), timeout.Token);
			if (!response.IsSuccessStatusCode)
			{
				return null;
			}

			using var body = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(timeout.Token), cancellationToken: timeout.Token);
			return body.RootElement.ValueKind == JsonValueKind.Object
				&& body.RootElement.TryGetProperty("processId", out var id)
				&& id.TryGetInt32(out var processId)
					? processId
					: null;
		}
		catch (Exception exception) when (exception is HttpRequestException or JsonException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
		{
			return null;
		}
		finally
		{
			if (owned)
			{
				client.Dispose();
			}
		}
	}

	private static async Task RequestStopAsync(LocalApiDiscovery discovery, HttpClient? client, CancellationToken cancellationToken)
	{
		var owned = client is null;
		client ??= new HttpClient();
		try
		{
			using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			timeout.CancelAfter(RequestTimeout);
			using var content = new StringContent("{}", Encoding.UTF8, "application/json");
			using var response = await client.PostAsync(new Uri(new Uri(discovery.Url), "/local/host/stop"), content, timeout.Token);
			if (response.StatusCode != HttpStatusCode.Accepted)
			{
				throw new LocalApiHostControlException(
					$"The Local API host at {discovery.Url} (process {discovery.ProcessId}) refused the stop request with HTTP {(int)response.StatusCode}.");
			}
		}
		catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
		{
			throw new LocalApiHostControlException(
				$"The Local API host at {discovery.Url} (process {discovery.ProcessId}) did not take the stop request: {exception.Message}", exception);
		}
		finally
		{
			if (owned)
			{
				client.Dispose();
			}
		}
	}

	private static async Task WaitForEndAsync(LocalApiDiscovery discovery, TimeSpan timeout, CancellationToken cancellationToken)
	{
		var clock = System.Diagnostics.Stopwatch.StartNew();
		while (discovery.IsProcessAlive())
		{
			if (clock.Elapsed > timeout)
			{
				throw new LocalApiHostControlException(
					$"The Local API host (process {discovery.ProcessId}) was asked to stop but is still running after {timeout.TotalSeconds:0} seconds. " +
					"It is finishing active requests. Run 'agent-logbook host status' later.");
			}

			await Task.Delay(PollInterval, cancellationToken);
		}
	}
}
