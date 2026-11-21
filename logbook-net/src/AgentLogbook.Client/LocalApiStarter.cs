using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Client;

/// <summary>
/// Starts the Local API host in the background when a local storage request needs it. The child is the same <c>agent-logbook serve</c> command
/// that a user runs by hand. It outlives the caller and has no idle shutdown.
/// </summary>
/// <remarks>
/// Duplicate hosts cannot happen: <c>serve</c> takes <c>local-api.start.lock</c> and refuses to start while the discovery file names a live host.
/// A caller whose child lost that race finds the running host through the discovery file, as every other caller does.
/// </remarks>
internal static class LocalApiStarter
{
	internal static readonly TimeSpan DefaultStartTimeout = TimeSpan.FromSeconds(60);

	private const long MaxLogBytes = 256 * 1024;
	private const int DiagnosticsBytes = 4096;
	private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(50);

	/// <summary>
	/// Starts one child and waits until the discovery file names a live host that answers its live check.
	/// </summary>
	/// <exception cref="LocalApiUnavailableException">The child cannot start, ends without a host, or does not become ready in time.</exception>
	public static async Task<BackendRoute> StartAsync(
		ShipyardLogbookFolder folder,
		LocalApiLaunch launch,
		Func<string, string?> getEnvironmentVariable,
		HttpClient? probeClient,
		TimeSpan timeout,
		CancellationToken cancellationToken)
	{
		if (OperatingSystem.IsWindows())
		{
			throw new LocalApiUnavailableException("The Local API host cannot start automatically on Windows yet. Start it with 'agent-logbook serve'.");
		}

		folder.EnsureExists();
		var logOffset = PrepareLog(folder);
		using var child = Spawn(folder, launch, getEnvironmentVariable);
		var clock = Stopwatch.StartNew();
		while (true)
		{
			cancellationToken.ThrowIfCancellationRequested();

			var route = await TryRouteAsync(folder, probeClient, cancellationToken);
			if (route is not null)
			{
				return route;
			}

			if (child.HasExited)
			{
				// Another start may have won the race while this child ended: look once more before this counts as a failure.
				route = await TryRouteAsync(folder, probeClient, cancellationToken);
				return route ?? throw Failure(folder, logOffset, $"The process ended with exit code {child.ExitCode}");
			}

			if (clock.Elapsed > timeout)
			{
				StopUnpublishedChild(folder, child);
				throw Failure(folder, logOffset, $"The host was not ready after {timeout.TotalSeconds:0} seconds");
			}

			await Task.Delay(PollInterval, cancellationToken);
		}
	}

	/// <summary>The route of a host that is alive and answers, or null. It never throws for a host that is down.</summary>
	internal static async Task<BackendRoute?> TryRouteAsync(ShipyardLogbookFolder folder, HttpClient? probeClient, CancellationToken cancellationToken)
	{
		var discovery = LocalApiDiscovery.Read(folder);
		if (discovery is null || !discovery.IsProcessAlive() || !Uri.TryCreate(discovery.Url, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttp)
		{
			return null;
		}

		return await BackendRouter.ProbeLiveAsync(url, probeClient, cancellationToken) is null
			? new BackendRoute(url, null, BackendRouteSource.LocalLogin)
			: null;
	}

	/// <summary>Keeps the log bounded: a large log is emptied before a start. Returns where the output of this start begins.</summary>
	private static long PrepareLog(ShipyardLogbookFolder folder)
	{
		try
		{
			var info = new FileInfo(folder.LogFile);
			if (info.Exists && info.Length > MaxLogBytes)
			{
				using var _ = new FileStream(folder.LogFile, FileMode.Truncate, FileAccess.Write, FileShare.ReadWrite);
			}

			info.Refresh();
			return info.Exists ? info.Length : 0;
		}
		catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
		{
			throw new LocalApiUnavailableException($"Cannot use the Local API log '{folder.LogFile}': {exception.Message}", exception);
		}
	}

	/// <summary>
	/// The shell redirects the output of the host into the log file and detaches its input before it becomes the host, so the host keeps
	/// working after the caller ends and never touches the standard streams of the caller (the MCP server speaks protocol on them).
	/// </summary>
	private static Process Spawn(ShipyardLogbookFolder folder, LocalApiLaunch launch, Func<string, string?> getEnvironmentVariable)
	{
		var info = new ProcessStartInfo("/bin/sh") { UseShellExecute = false, WorkingDirectory = folder.Path };
		info.ArgumentList.Add("-c");
		info.ArgumentList.Add("log=$1; shift; trap '' INT HUP; exec \"$@\" >>\"$log\" 2>&1 </dev/null");
		info.ArgumentList.Add("agent-logbook-start");
		info.ArgumentList.Add(folder.LogFile);
		info.ArgumentList.Add(launch.FileName);
		foreach (var argument in launch.Arguments)
		{
			info.ArgumentList.Add(argument);
		}

		// The settings of the caller decide the host, whether they come from the process environment or from an explicit lookup.
		info.Environment[ShipyardLogbookFolder.HomeVariable] = Path.GetDirectoryName(folder.Path)!;
		if (getEnvironmentVariable(LocalPostgresSelection.UrlVariable) is { } postgresUrl)
		{
			info.Environment[LocalPostgresSelection.UrlVariable] = postgresUrl;
		}
		else
		{
			info.Environment.Remove(LocalPostgresSelection.UrlVariable);
		}

		try
		{
			return Process.Start(info) ?? throw new LocalApiUnavailableException("The Local API host process did not start.");
		}
		catch (Exception exception) when (exception is Win32Exception or InvalidOperationException)
		{
			throw new LocalApiUnavailableException($"The Local API host process cannot start: {exception.Message}", exception);
		}
	}

	private static void StopUnpublishedChild(ShipyardLogbookFolder folder, Process child)
	{
		if (LocalApiDiscovery.Read(folder)?.ProcessId == child.Id)
		{
			return;
		}

		try
		{
			child.Kill(entireProcessTree: true);
		}
		catch (InvalidOperationException)
		{
			// It ended in the meantime.
		}
	}

	private static LocalApiUnavailableException Failure(ShipyardLogbookFolder folder, long logOffset, string reason)
	{
		var written = ReadLogTail(folder.LogFile, logOffset);
		return new LocalApiUnavailableException(string.IsNullOrEmpty(written)
			? $"The Local API host did not start. {reason}, and it wrote nothing to {folder.LogFile}."
			: $"The Local API host did not start. {reason}. It wrote: {written} (log: {folder.LogFile})");
	}

	/// <summary>The end of what the log got since <paramref name="offset"/>, at most <see cref="DiagnosticsBytes"/> bytes, on one line.</summary>
	private static string ReadLogTail(string file, long offset)
	{
		try
		{
			using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
			var start = Math.Max(Math.Min(offset, stream.Length), stream.Length - DiagnosticsBytes);
			stream.Seek(start, SeekOrigin.Begin);
			var buffer = new byte[stream.Length - start];
			stream.ReadExactly(buffer);
			var lines = Encoding.UTF8.GetString(buffer).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
			return string.Join(' ', lines);
		}
		catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
		{
			return string.Empty;
		}
	}
}
