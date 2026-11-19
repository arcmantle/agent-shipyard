using System.Diagnostics;
using System.Text.Json;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Cli.Tests.Serve;

/// <summary>Runs <c>agent-logbook serve</c> as a real process with its own Shipyard data folder.</summary>
internal sealed class ServeProcess : IAsyncDisposable
{
	private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(60);

	private readonly Process process;
	private readonly System.Text.StringBuilder output = new();
	private readonly System.Text.StringBuilder error = new();

	private ServeProcess(string shipyardHome, Process process)
	{
		ShipyardHome = shipyardHome;
		Folder = ShipyardLogbookFolder.Resolve(name => name == ShipyardLogbookFolder.HomeVariable ? shipyardHome : null, shipyardHome);
		this.process = process;
		process.OutputDataReceived += (_, e) => Append(output, e.Data);
		process.ErrorDataReceived += (_, e) => Append(error, e.Data);
	}

	internal string ShipyardHome { get; }

	internal ShipyardLogbookFolder Folder { get; }

	internal int ProcessId => process.Id;

	internal bool HasExited => process.HasExited;

	internal string Output => Snapshot(output);

	internal string Error => Snapshot(error);

	internal static string NewShipyardHome() => Directory.CreateTempSubdirectory("serve-shipyard-").FullName;

	internal static ServeProcess Start(string shipyardHome, string postgresUrl, params (string Name, string Value)[] extraEnvironment)
	{
		var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
		{
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		info.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "AgentLogbook.Cli.dll"));
		info.ArgumentList.Add("serve");
		info.Environment[ShipyardLogbookFolder.HomeVariable] = shipyardHome;
		info.Environment[LocalPostgresSelection.UrlVariable] = postgresUrl;
		foreach (var (name, value) in extraEnvironment)
		{
			info.Environment[name] = value;
		}

		var started = Process.Start(info) ?? throw new InvalidOperationException("The serve process did not start.");
		var serve = new ServeProcess(shipyardHome, started);
		started.BeginOutputReadLine();
		started.BeginErrorReadLine();
		return serve;
	}

	/// <summary>Waits for the discovery file or for the process to end, whichever comes first.</summary>
	internal async Task<LocalApiDiscovery?> WaitForDiscoveryAsync()
	{
		var deadline = Stopwatch.StartNew();
		while (deadline.Elapsed < StartTimeout)
		{
			var discovery = LocalApiDiscovery.Read(Folder);
			if (discovery is not null)
			{
				return discovery;
			}

			if (process.HasExited)
			{
				return null;
			}

			await Task.Delay(50);
		}

		throw new TimeoutException($"The serve process published no discovery file in {StartTimeout}.{Environment.NewLine}{Output}{Error}");
	}

	internal async Task<int> WaitForExitAsync()
	{
		using var timeout = new CancellationTokenSource(StartTimeout);
		await process.WaitForExitAsync(timeout.Token);
		process.WaitForExit();
		return process.ExitCode;
	}

	/// <summary>Sends the termination signal that a service manager or a shell sends.</summary>
	internal void Terminate()
	{
		using var kill = Process.Start("kill", ["-TERM", process.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)])!;
		kill.WaitForExit();
	}

	internal static async Task<JsonElement> GetJsonAsync(string url, int expectedStatus)
	{
		using var client = new HttpClient();
		using var response = await client.GetAsync(url);
		if ((int)response.StatusCode != expectedStatus)
		{
			throw new InvalidOperationException($"{url} answered {(int)response.StatusCode}, expected {expectedStatus}.");
		}

		return JsonElement.Parse(await response.Content.ReadAsStringAsync());
	}

	public async ValueTask DisposeAsync()
	{
		if (!process.HasExited)
		{
			process.Kill(entireProcessTree: true);
			await process.WaitForExitAsync();
		}

		process.Dispose();
		try
		{
			Directory.Delete(ShipyardHome, recursive: true);
		}
		catch (IOException)
		{
			// A temporary folder that stays is not a test failure.
		}
	}

	private static void Append(System.Text.StringBuilder builder, string? line)
	{
		if (line is null)
		{
			return;
		}

		lock (builder)
		{
			builder.AppendLine(line);
		}
	}

	private static string Snapshot(System.Text.StringBuilder builder)
	{
		lock (builder)
		{
			return builder.ToString();
		}
	}
}
