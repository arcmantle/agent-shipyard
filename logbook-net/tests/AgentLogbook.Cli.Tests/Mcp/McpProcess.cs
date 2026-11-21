using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Cli.Tests.Mcp;

/// <summary>Runs <c>agent-logbook --mcp</c> as a real process and speaks line-delimited JSON-RPC to it, as an MCP host does.</summary>
internal sealed class McpProcess : IAsyncDisposable
{
	private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(60);

	private readonly Process process;
	private readonly System.Text.StringBuilder error = new();
	private readonly Func<string, JsonNode?>? answerServerRequest;
	private int nextId;

	private McpProcess(Process process, Func<string, JsonNode?>? answerServerRequest)
	{
		this.process = process;
		this.answerServerRequest = answerServerRequest;
		process.ErrorDataReceived += (_, e) =>
		{
			if (e.Data is not null)
			{
				lock (error)
				{
					error.AppendLine(e.Data);
				}
			}
		};
	}

	/// <summary>Everything the process wrote to standard error.</summary>
	internal string Error
	{
		get
		{
			lock (error)
			{
				return error.ToString();
			}
		}
	}

	/// <summary>
	/// Starts the process in <paramref name="workspace"/>. <paramref name="answerServerRequest"/> answers the requests that the server sends to the host,
	/// by method name (for example <c>roots/list</c>); it returns the <c>result</c>.
	/// </summary>
	internal static McpProcess Start(string workspace, string? shipyardHome, string[] arguments, Func<string, JsonNode?>? answerServerRequest = null, string? apiUrl = null)
	{
		var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
		{
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
			WorkingDirectory = workspace,
		};
		info.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "AgentLogbook.Cli.dll"));
		info.ArgumentList.Add("--mcp");
		foreach (var argument in arguments)
		{
			info.ArgumentList.Add(argument);
		}

		foreach (var name in new[] { "AGENT_LOGBOOK_API_URL", "AGENT_SHIPYARD_PROJECT_IDENTITY", "AGENT_ISSUES_PROJECT_IDENTITY" })
		{
			info.Environment.Remove(name);
		}

		if (shipyardHome is not null)
		{
			info.Environment[ShipyardLogbookFolder.HomeVariable] = shipyardHome;
		}

		if (apiUrl is not null)
		{
			info.Environment["AGENT_LOGBOOK_API_URL"] = apiUrl;
		}

		var started = Process.Start(info) ?? throw new InvalidOperationException("The MCP process did not start.");
		var mcp = new McpProcess(started, answerServerRequest);
		started.BeginErrorReadLine();
		return mcp;
	}

	/// <summary>Sends a request and returns the whole response object. Every line that the process writes must be a JSON-RPC message.</summary>
	internal async Task<JsonNode> RequestAsync(string method, JsonNode? parameters = null)
	{
		var id = ++nextId;
		await WriteAsync(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters });
		while (true)
		{
			var message = await ReadAsync();
			if (message["method"] is JsonValue methodValue)
			{
				// A request or notification from the server.
				var serverMethod = methodValue.GetValue<string>();
				if (message["id"] is { } serverId)
				{
					await WriteAsync(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = serverId.DeepClone(), ["result"] = answerServerRequest?.Invoke(serverMethod) ?? new JsonObject() });
				}

				continue;
			}

			if (message["id"]?.GetValue<int>() == id)
			{
				return message;
			}
		}
	}

	internal async Task NotifyAsync(string method) =>
		await WriteAsync(new JsonObject { ["jsonrpc"] = "2.0", ["method"] = method });

	/// <summary>Runs the initialize handshake and returns the initialize result.</summary>
	internal async Task<JsonNode> InitializeAsync(bool withRoots = false)
	{
		var capabilities = new JsonObject();
		if (withRoots)
		{
			capabilities["roots"] = new JsonObject();
		}

		var response = await RequestAsync("initialize", new JsonObject
		{
			["protocolVersion"] = "2025-06-18",
			["capabilities"] = capabilities,
			["clientInfo"] = new JsonObject { ["name"] = "test-host", ["version"] = "1.0.0" },
		});
		await NotifyAsync("notifications/initialized");
		return response["result"] ?? throw new InvalidOperationException($"initialize failed: {response}");
	}

	/// <summary>Calls a tool and returns its <c>result</c>.</summary>
	internal async Task<JsonNode> CallToolAsync(string name, JsonNode arguments)
	{
		var response = await RequestAsync("tools/call", new JsonObject { ["name"] = name, ["arguments"] = arguments });
		return response["result"] ?? throw new InvalidOperationException($"tools/call failed: {response}");
	}

	/// <summary>Closes the input of the server and waits for the process to end.</summary>
	internal async Task<int> CloseInputAndWaitAsync()
	{
		process.StandardInput.Close();
		using var timeout = new CancellationTokenSource(ReadTimeout);
		await process.WaitForExitAsync(timeout.Token);
		return process.ExitCode;
	}

	/// <summary>Reads what is left on standard output after the input was closed. Each line must be a JSON-RPC message.</summary>
	internal async Task<IReadOnlyList<string>> DrainOutputAsync()
	{
		var lines = new List<string>();
		while (await process.StandardOutput.ReadLineAsync() is { } line)
		{
			lines.Add(line);
		}

		return lines;
	}

	public async ValueTask DisposeAsync()
	{
		if (!process.HasExited)
		{
			process.Kill(entireProcessTree: true);
			await process.WaitForExitAsync();
		}

		process.Dispose();
	}

	private async Task WriteAsync(JsonNode message)
	{
		await process.StandardInput.WriteLineAsync(message.ToJsonString());
		await process.StandardInput.FlushAsync();
	}

	private async Task<JsonNode> ReadAsync()
	{
		using var timeout = new CancellationTokenSource(ReadTimeout);
		var line = await process.StandardOutput.ReadLineAsync(timeout.Token)
			?? throw new InvalidOperationException($"The MCP process closed standard output.{Environment.NewLine}{Error}");
		try
		{
			var message = JsonNode.Parse(line);
			return message is JsonObject { } obj && obj["jsonrpc"]?.GetValue<string>() == "2.0"
				? obj
				: throw new InvalidOperationException($"Standard output has a line that is not a JSON-RPC message: {line}");
		}
		catch (JsonException)
		{
			throw new InvalidOperationException($"Standard output has a line that is not JSON: {line}");
		}
	}
}
